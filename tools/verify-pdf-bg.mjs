// 独立验证 PDF 背景：不经过服务器，自己生成打印页 → 调浏览器导出 → 检查白边
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPrintHtml, renderPdf, detectBrowser } from "../lib/pdf.mjs";
import { load } from "../lib/store.mjs";
import { checkBleed } from "./check-pdf-bg.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "build", "pdfverify");
fs.mkdirSync(outDir, { recursive: true });

const browser = detectBrowser();
console.log("浏览器:", browser || "未找到");
if (!browser) process.exit(1);

const themes = process.argv.slice(2).length ? process.argv.slice(2) : ["darkcode", "sepia"];
let bad = 0;

for (const theme of themes) {
  const html = await buildPrintHtml({
    doc: load(), theme, scope: "all", twoColumn: true, includeCode: true, includeNote: true, lang: "zh-CN",
  });
  // 打印页里用的是 /vendor/... 绝对路径，改成 file:// 才能本地打开
  const vendor = pathToFileURL(path.join(root, "public", "vendor")).href;
  const local = html.replace(/(src|href)="\/vendor\//g, `$1="${vendor}/`);
  const htmlPath = path.join(outDir, `print-${theme}.html`);
  fs.writeFileSync(htmlPath, local, "utf8");

  const pdfPath = path.join(outDir, `${theme}.pdf`);
  try { fs.rmSync(pdfPath, { force: true }); } catch {}
  process.stdout.write(`\n[${theme}] 正在渲染… `);
  try {
    const r = await renderPdf({ url: pathToFileURL(htmlPath).href, outPath: pdfPath, timeoutMs: 90000 });
    console.log(`${(r.size / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.log("失败");
    console.log("  " + String(e.message).split("\n").slice(0, 3).join("\n  "));
    bad++;
    continue;
  }

  const bleed = checkBleed(pdfPath);
  const mm = (v) => (v / 72 * 25.4).toFixed(1);
  for (const p of bleed.pages) {
    if (p.full) console.log(`  第 ${p.index} 页  背景铺满整页 ✓`);
    else {
      const g = p.rect;
      console.log(`  第 ${p.index} 页  ✗ 白边 左${mm(g.x)} 右${mm(bleed.pageSize.W - g.x - g.w)} 上${mm(bleed.pageSize.H - g.y - g.h)} 下${mm(g.y)} mm`);
      bad++;
    }
  }
}

console.log(bad === 0 ? "\n✅ 所有页面背景铺满，没有白边" : `\n❌ 有 ${bad} 处问题`);
process.exit(bad ? 1 : 0);
