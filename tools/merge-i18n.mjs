// 把 locales/parts/*.json 合并成 locales/zh-CN.json（各部分的键不能冲突）
// 用法：node tools/merge-i18n.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const partsDir = path.join(root, "locales", "parts");
const files = fs.readdirSync(partsDir).filter((f) => f.endsWith(".json")).sort();

const merged = {};
const owner = {};
let conflicts = 0;
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(partsDir, f), "utf8"));
  const keys = Object.keys(data);
  for (const k of keys) {
    if (owner[k] && owner[k] !== f) {
      const same = merged[k] === data[k];
      console.error(`冲突：${k} 同时出现在 ${owner[k]} 和 ${f}（值${same ? "相同" : "不同"}）`);
      if (!same) conflicts++;
      continue;
    }
    owner[k] = f;
    merged[k] = data[k];
  }
  console.log(`  ${f.padEnd(14)} ${String(keys.length).padStart(4)} 条`);
}

// 按下标排序，方便人工校对
const sorted = {};
for (const k of Object.keys(merged).sort()) sorted[k] = merged[k];
fs.writeFileSync(path.join(root, "locales", "zh-CN.json"), JSON.stringify(sorted, null, 2) + "\n", "utf8");
console.log(`\n合并结果：${Object.keys(sorted).length} 条 → locales/zh-CN.json`);
process.exit(conflicts ? 1 : 0);
