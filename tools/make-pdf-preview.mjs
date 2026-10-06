// 生成一份「只含一道题」的打印页 HTML，用于拍「导出 PDF 首页」预览图
// 与真正导出 PDF 用的是同一个 buildPrintHtml，只是 scope=current，
// 所以渲染出来就是 PDF 第一页的版式（A4 宽 210mm，四周留白由内边距提供）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrintHtml } from "../lib/pdf.mjs";
import { load, flattenProblems } from "../lib/store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "build", "preview-serve");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const doc = load();
const problems = flattenProblems(doc.tree ?? []);
const target = problems.find((p) => p.pid === (process.argv[2] || "P3374")) ?? problems[0];
if (!target) { console.error("笔记本里没有题目"); process.exit(1); }

// 顺便把前端离线依赖复制过去，让 /vendor/... 能正常加载（KaTeX 公式渲染）
const src = path.join(root, "public", "vendor");
const dst = path.join(outDir, "vendor");
if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
fs.cpSync(path.join(root, "public", "style.css"), path.join(outDir, "style.css"));

const html = await buildPrintHtml({
  doc, theme: process.argv[3] || "darkcode", scope: "current", targetId: target.id,
  twoColumn: true, includeCode: true, includeNote: true, lang: "zh-CN",
});
fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");

console.log(`已生成: ${path.join(outDir, "index.html")}`);
console.log(`  题目: ${target.pid} ${target.title}`);
console.log(`  配色: ${process.argv[3] || "darkcode"}`);
console.log(`  vendor 资源已就位: ${fs.existsSync(dst)}`);
