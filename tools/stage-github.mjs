// 把「可以公开的文件」铺到目录里，方便通过 GitHub 网页拖拽上传
// 复用 tools/package.mjs 的排除规则与换行符规范化，保证与发布包内容完全一致
//
// GitHub 网页上传单次上限 100 个文件，本项目有 107 个（其中 65 个是 KaTeX 字体等前端离线依赖），
// 所以要分两批：
//   node tools/stage-github.mjs 1   → 除 public/vendor 之外的全部文件（拖 dist/github-upload/第一批）
//   node tools/stage-github.mjs 2   → 只有 public/vendor（拖 dist/github-upload/第二批）
//
// 布局要点：项目文件直接放在「第一批」这一层，不要再多套一层仓库名目录。
// GitHub 拖拽上传时按「被拖文件夹」取相对路径，多套一层就会在仓库里多出一个子目录。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackage } from "./package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const batch = process.argv[2] || "all";

const inBatch = (rel) => {
  const isVendor = rel.startsWith("public/vendor/");
  if (batch === "1") return !isVendor;
  if (batch === "2") return isVendor;
  return true;
};

const dirName = batch === "1" ? "第一批" : batch === "2" ? "第二批" : "全部";
const stage = path.join(root, "dist", "github-upload", dirName);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const { entries, prefix } = buildPackage({ outDir: path.join(root, "dist") });
let n = 0, bytes = 0;
const skipped = [];
for (const e of entries) {
  const rel = e.name.startsWith(prefix + "/") ? e.name.slice(prefix.length + 1) : e.name;
  if (!inBatch(rel)) continue;
  // 浏览器拖拽文件夹时会跳过隐藏文件（.gitignore / .gitattributes），单独记下来另行创建
  if (path.basename(rel).startsWith(".")) { skipped.push(rel); continue; }
  const dest = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, e.data);
  n++; bytes += e.data.length;
}

console.log(`批次 ${batch} 已铺好：${stage}`);
console.log(`  文件数 ${n}，合计 ${(bytes / 1024).toFixed(0)} KB`);
console.log(`  请拖拽这个文件夹：${stage}`);
if (skipped.length) console.log(`  隐藏文件（拖拽会被跳过，稍后用网页编辑器单独创建）：${skipped.join(", ")}`);

