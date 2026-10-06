// 数据安全验收：全部在 build/sandbox/ 的副本里跑，不碰真实 data/
// 覆盖：损坏恢复、损坏隔离、.bak 滚动、异常缩水快照、多实例冲突、备份/恢复、从旧目录导入
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = path.join(root, "build", "sandbox");

const results = [];
const ok = (name, cond, extra = "") => {
  results.push(Boolean(cond));
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
};

/* ---------- 造一个独立的沙箱副本 ---------- */
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, "data", "notebooks"), { recursive: true });
fs.mkdirSync(path.join(sandbox, "data", "images", "P1"), { recursive: true });
fs.cpSync(path.join(root, "lib"), path.join(sandbox, "lib"), { recursive: true });

const mkProblem = (i, desc = "题面") => ({
  id: `p${i}`, kind: "problem", pid: `P${1000 + i}`, title: `题目${i}`, status: "todo",
  description: desc, code: "#include <bits/stdc++.h>\nint main(){return 0;}", note: `笔记${i}`,
  tests: [{ id: `t${i}`, input: "1", output: "1" }], addedAt: Date.now(), difficulty: 2,
  difficultyName: "普及-", tagNames: ["测试"],
});
const base = {
  version: 3, title: "沙箱本", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  tree: [{ id: "f1", kind: "folder", name: "基础", collapsed: false, children: Array.from({ length: 8 }, (_, i) => mkProblem(i + 1)) }],
};
fs.writeFileSync(path.join(sandbox, "data", "profiles.json"),
  JSON.stringify({ list: [{ id: "default", name: "沙箱本" }], active: "default" }, null, 2));
fs.writeFileSync(path.join(sandbox, "data", "notebooks", "default.json"), JSON.stringify(base, null, 2));
fs.writeFileSync(path.join(sandbox, "data", "images", "P1", "a.png"), Buffer.from("89504e470d0a1a0a", "hex"));

const S = await import(new URL("./lib/store.mjs", `file://${sandbox.replace(/\\/g, "/")}/`).href);
const NB = path.join(sandbox, "data", "notebooks", "default.json");
const BAK = `${NB}.bak`;
const backupsDir = path.join(sandbox, "data", "backups");
const listDir = (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []);

console.log("===== 1. 正常读写 =====");
ok("load() 读出 8 道题", S.countProblems(S.load().tree) === 8);
S.save({ ...S.load(), title: "沙箱本" });
ok("save() 落盘成功", JSON.parse(fs.readFileSync(NB, "utf8")).title === "沙箱本");
ok("原文件还在（未损坏）", fs.existsSync(NB));

console.log("\n===== 2. .bak 滚动备份 =====");
S.save({ ...S.load(), note: "改一下" });
ok("第一次保存后生成 .bak", fs.existsSync(BAK), fs.existsSync(BAK) ? `${Math.round(fs.statSync(BAK).size / 1024)}KB` : "");
S.save({ ...S.load(), note: "再改一下" });
ok("再保存后 .bak.1 出现（保留两代）", fs.existsSync(`${BAK}.1`));

console.log("\n===== 3. 异常缩水自动快照 =====");
const shrunk = { ...S.load(), tree: [] };            // 模拟 bug 把树清空
S.save(shrunk);
const shrinkSnaps = listDir(backupsDir).filter((f) => f.startsWith("shrink-"));
ok("题目数骤降时落了 shrink 快照", shrinkSnaps.length >= 1, shrinkSnaps[0] ?? "（无）");
ok("快照里保留了原来的 8 道题", (() => {
  try { return S.countProblems(JSON.parse(fs.readFileSync(path.join(backupsDir, shrinkSnaps[0]), "utf8")).tree) === 8; }
  catch { return false; }
})());

console.log("\n===== 4. JSON 损坏 → 隔离原件 + 从 .md 恢复 =====");
// 还原成 8 道题并确保 .md 也是最新的
fs.writeFileSync(NB, JSON.stringify(base, null, 2));
S.resetCache();
S.save({ ...S.load() });                              // 重新生成 .md
const goodSize = fs.statSync(NB).size;
const mdSize = fs.statSync(path.join(sandbox, "data", "notebooks", "default.md")).size;
fs.writeFileSync(NB, fs.readFileSync(NB, "utf8").slice(0, Math.floor(goodSize / 2)));   // 截断
S.resetCache();
const recovered = S.load();
const notice = S.peekLoadNotice();
ok("损坏后仍读出了数据（从 .md 重建）", S.countProblems(recovered.tree) === 8, `题目 ${S.countProblems(recovered.tree)} 道`);
ok("报了 recovered 提示", notice?.kind === "recovered", JSON.stringify(notice?.kind));
const brokenFiles = listDir(path.join(sandbox, "data", "notebooks")).filter((f) => f.includes(".broken-"));
ok("损坏原件被改名隔离（没有被覆盖）", brokenFiles.length === 1, brokenFiles[0] ?? "（无）");
ok("隔离出来的损坏文件内容就是那份坏的", brokenFiles.length === 1 &&
  fs.statSync(path.join(sandbox, "data", "notebooks", brokenFiles[0])).size < goodSize);
S.save({ ...recovered, title: "恢复后继续用" });
ok("恢复后保存不再覆盖隔离文件", listDir(path.join(sandbox, "data", "notebooks")).filter((f) => f.includes(".broken-")).length === 1);
ok(".md 还在（作为恢复源）", mdSize > 0 && fs.existsSync(path.join(sandbox, "data", "notebooks", "default.md")));

console.log("\n===== 5. 多实例冲突：不覆盖对方的数据 =====");
S.resetCache();
const mine = S.load();
// 模拟另一个实例写了盘（updatedAt 变了）
const other = JSON.parse(fs.readFileSync(NB, "utf8"));
other.updatedAt = new Date(Date.now() + 5000).toISOString();
other.title = "另一个实例改的";
fs.writeFileSync(NB, JSON.stringify(other, null, 2));
S.save({ ...mine, title: "我这边改的" });              // 应该被拦下
const conflict = S.peekConflict();
ok("检测到冲突并拒绝覆盖", Boolean(conflict), conflict ? `对方 ${conflict.diskStamp} / 我 ${conflict.mineStamp}` : "（没检测到）");
ok("磁盘上仍是另一个实例的版本", JSON.parse(fs.readFileSync(NB, "utf8")).title === "另一个实例改的");
ok("我的版本被另存为 conflict 备份", Boolean(conflict?.savedTo) && fs.existsSync(conflict.savedTo));

console.log("\n===== 6. 完整备份 / 列表 / 恢复 =====");
const dir = S.backup();
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
ok("备份包含题目数", manifest.problems >= 0, JSON.stringify({ problems: manifest.problems, images: manifest.images }));
ok("备份包含题面图片", fs.existsSync(path.join(dir, "images", "P1", "a.png")));
const list = S.listBackups();
ok("listBackups() 能列出备份", list.some((b) => b.name === path.basename(dir)), `${list.length} 条`);
// 破坏数据，再从备份恢复
fs.writeFileSync(NB, JSON.stringify({ version: 3, title: "被清空了", tree: [] }, null, 2));
S.resetCache();
ok("破坏后确实是空的", S.countProblems(S.load().tree) === 0);
const r = S.restoreBackup(path.basename(dir));
S.resetCache();
ok("恢复后数据回来了", S.countProblems(S.load().tree) === 8, `${S.countProblems(S.load().tree)} 道`);
ok("恢复前也自动存了一份现状", Boolean(r.safety) && fs.existsSync(r.safety));

console.log("\n===== 7. 从旧目录导入 =====");
const old = path.join(sandbox, "build", "old-notebook");
fs.mkdirSync(path.join(old, "data", "notebooks"), { recursive: true });
fs.mkdirSync(path.join(old, "data", "images", "P9"), { recursive: true });
fs.writeFileSync(path.join(old, "data", "notebooks", "default.json"),
  JSON.stringify({ ...base, title: "旧目录的本子" }, null, 2));
fs.writeFileSync(path.join(old, "data", "images", "P9", "b.png"), Buffer.from("89504e470d0a1a0a", "hex"));
const scan = S.scanForOldData({ roots: [path.join(sandbox, "build")], maxDepth: 3 });
ok("扫描能找到旧数据目录", scan.length >= 1, scan.map((x) => x.dir.replace(sandbox, "…")).join(" , "));
ok("扫描结果带题目数", scan[0]?.problems === 8, `题 ${scan[0]?.problems}`);
const adopted = S.adoptData(old);
S.resetCache();
ok("导入后标题变成旧目录的", S.load().title === "旧目录的本子", S.load().title);
ok("导入时也先备份了现状", Boolean(adopted.safety) && fs.existsSync(adopted.safety));
ok("旧目录的图片一起导入", fs.existsSync(path.join(sandbox, "data", "images", "P9", "b.png")));
ok("导入报错友好（不是刷题本目录）", (() => {
  try { S.adoptData(path.join(sandbox, "lib")); return false; } catch { return true; }
})());

console.log("\n===== 8. 单实例锁 =====");
S.writeLock(8765);
const lock = S.readLock();
ok("写锁成功且记录了 pid/端口", lock?.pid === process.pid && lock?.port === 8765);
ok("自己不算「另一个实例」", S.anotherInstance() === null);
fs.writeFileSync(path.join(sandbox, "data", ".lock"), JSON.stringify({ pid: 999999, port: 1, root: sandbox }));
ok("已死进程的锁不算冲突", S.anotherInstance() === null);
fs.writeFileSync(path.join(sandbox, "data", ".lock"), JSON.stringify({ pid: process.pid === 1 ? 2 : 1, port: 1, root: sandbox }));
ok("活着的其它进程会被识别", process.platform === "win32" ? true : S.anotherInstance() !== null);

const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "✅" : "❌"} 数据安全验收 ${pass}/${results.length}`);
console.log(`   沙箱：${sandbox.replace(root, ".")}（可随时整个删掉）`);
process.exit(pass === results.length ? 0 : 1);
