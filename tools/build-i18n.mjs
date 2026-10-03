// 由 locales/*.json 生成 public/locales.js（内联字典，保证离线可用）
// 用法：node tools/build-i18n.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "locales");
const LANGS = ["zh-CN", "zh-TW", "en"];

const dicts = {};
for (const id of LANGS) {
  const f = path.join(dir, `${id}.json`);
  if (!fs.existsSync(f)) { console.error(`缺少 ${f}`); process.exit(1); }
  try { dicts[id] = JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { console.error(`${id}.json 不是合法 JSON：${e.message}`); process.exit(1); }
}

// 键一致性检查：以 zh-CN 为基准
const base = Object.keys(dicts["zh-CN"]).sort();
let missing = 0;
for (const id of LANGS) {
  if (id === "zh-CN") continue;
  const keys = new Set(Object.keys(dicts[id]));
  const miss = base.filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !(k in dicts["zh-CN"]));
  if (miss.length) { console.error(`✗ ${id} 缺少 ${miss.length} 个键：${miss.slice(0, 12).join(", ")}${miss.length > 12 ? " …" : ""}`); missing += miss.length; }
  if (extra.length) console.error(`✗ ${id} 多出 ${extra.length} 个键：${extra.slice(0, 12).join(", ")}`);
  const empty = base.filter((k) => !String(dicts[id][k] ?? "").trim());
  if (empty.length) { console.error(`✗ ${id} 有 ${empty.length} 个空翻译：${empty.slice(0, 12).join(", ")}`); missing += empty.length; }
}

const out = `// 本文件由 tools/build-i18n.mjs 自动生成，请勿手改；改文案请编辑 locales/*.json
window.__I18N_DICT__ = ${JSON.stringify(dicts, null, 1)};
`;
fs.writeFileSync(path.join(root, "public", "locales.js"), out, "utf8");

console.log(`字典条数：${base.length}`);
for (const id of LANGS) console.log(`  ${id.padEnd(6)} ${Object.keys(dicts[id]).length} 条`);
console.log(missing ? "✗ 存在缺失，请补齐" : "✓ 键一致，已生成 public/locales.js");
process.exit(missing ? 1 : 0);
