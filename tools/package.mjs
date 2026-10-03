// 打包成可分发的 zip（零依赖：自己写一个 STORE 方式的 zip 写入器，跨平台可用）
// 用法: node tools/package.mjs [--out dist]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outDir = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? path.resolve(root, process.argv[i + 1]) : path.join(root, "dist");
})();

/** 不进包的东西：个人数据、编译产物、缓存 */
const EXCLUDE_DIRS = new Set(["data", "exports", "build", "node_modules", ".git", "dist", "docs", ".vscode", ".idea"]);
const EXCLUDE_FILES = new Set(["config.json", ".DS_Store", "Thumbs.db"]);
const EXCLUDE_PATH_PARTS = ["tools/bin"];

/* ---------------- 最小 ZIP 写入器（store，不压缩） ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function zipWrite(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    local.writeUInt16LE(0, 8);           // store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 42);            // 外部属性
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ---------------- 换行符规范化 ----------------
   Windows 的 .bat 必须是 CRLF，否则 cmd.exe 会把行尾吃掉导致命令串行、报
   「'xxx' is not recognized as an internal or external command」；
   反过来 .sh 必须是 LF，否则 Linux 上会报 bad interpreter: /bin/bash^M。
   不管源文件怎么存的，打包时统一纠正。 */
export function normalizeEol(rel, buf) {
  if (/\.(bat|cmd|ps1)$/i.test(rel)) {
    return Buffer.from(buf.toString("utf8").replace(/\r?\n/g, "\r\n"), "utf8");
  }
  if (/\.(sh|bash)$/i.test(rel)) {
    return Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  }
  return buf;
}

/* ---------------- 收集文件 ---------------- */
function collect(dir, base = "") {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (EXCLUDE_FILES.has(name)) continue;
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (EXCLUDE_PATH_PARTS.some((p) => rel.startsWith(p))) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      out.push(...collect(full, rel));
    } else {
      if (/\.(tmp|log)$/.test(name)) continue;
      out.push({ rel, full });
    }
  }
  return out;
}

export function buildPackage({ outDir: customOut } = {}) {
  const target = customOut ?? outDir;
  const files = collect(root);
  const prefix = `${pkg.name}-v${pkg.version}`;
  const entries = files.map((f) => ({
    name: `${prefix}/${f.rel}`,
    data: normalizeEol(f.rel, fs.readFileSync(f.full)),
    rel: f.rel,
  }));

  // 包里放一份空的 data 目录说明，让新用户知道数据存哪
  entries.push({
    name: `${prefix}/data/把数据放这里.txt`,
    rel: "data/把数据放这里.txt",
    data: Buffer.from("刷题本第一次启动时会自动在这里生成档案文件：\n  notebooks/<档案名>.json   结构化数据（唯一数据源）\n  notebooks/<档案名>.md     自动导出的 Markdown\n  backups/                  手动备份\n\n这个目录可以直接拷走备份，也不要提交到 Git。\n", "utf8"),
  });

  fs.mkdirSync(target, { recursive: true });
  const zipPath = path.join(target, `${prefix}.zip`);
  fs.writeFileSync(zipPath, zipWrite(entries));
  return { zipPath, entries, prefix, version: pkg.version };
}

/* ---------------- 命令行入口 ---------------- */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = buildPackage({});
  const size = fs.statSync(r.zipPath).size;
  const eolOf = (rel) => {
    const e = r.entries.find((x) => x.rel === rel);
    if (!e) return "（不在包里）";
    const crlf = (e.data.toString("latin1").match(/\r\n/g) ?? []).length;
    const lf = (e.data.toString("latin1").match(/(?<!\r)\n/g) ?? []).length;
    return crlf && !lf ? "CRLF ✓" : lf && !crlf ? "LF ✓" : `混合(CRLF=${crlf},LF=${lf})`;
  };
  console.log("");
  console.log(`  打包完成：${r.zipPath}`);
  console.log(`  版本：v${r.version}　文件数：${r.entries.length}　体积：${(size / 1024).toFixed(0)} KB`);
  console.log("");
  console.log(`  换行符自检：start.bat = ${eolOf("start.bat")}　start.sh = ${eolOf("start.sh")}`);
  console.log("");
  console.log("  包里包含：");
  for (const e of r.entries.slice(0, 12)) console.log(`    ${e.name.replace(r.prefix + "/", "")}`);
  if (r.entries.length > 12) console.log(`    …（其余 ${r.entries.length - 12} 个）`);
  console.log("");
  console.log("  已排除：data/ exports/ build/ config.json docs/ tools/bin/");
  console.log("  对方解压后双击 start.bat（Windows）或 ./start.sh（macOS / Linux）即可。");
  console.log("");
}
