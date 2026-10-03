// 一次性脚本：把前端依赖抓到 public/vendor/，之后完全离线可用。
// 用法: node tools/fetch-vendor.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "public", "vendor");
const CDN = "https://cdn.jsdelivr.net/npm";

const FILES = [
  { url: `${CDN}/marked@12.0.2/marked.min.js`, out: "marked/marked.min.js" },
  { url: `${CDN}/dompurify@3.1.6/dist/purify.min.js`, out: "dompurify/purify.min.js" },
  { url: `${CDN}/katex@0.16.11/dist/katex.min.js`, out: "katex/katex.min.js" },
  { url: `${CDN}/katex@0.16.11/dist/contrib/auto-render.min.js`, out: "katex/auto-render.min.js" },
  { url: `${CDN}/katex@0.16.11/dist/katex.min.css`, out: "katex/katex.min.css" },
];

async function download(url, out) {
  const dest = path.join(vendor, out);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`skip  ${out}`);
    return fs.readFileSync(dest, "utf8");
  }
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(`get   ${out}  ${(buf.length / 1024).toFixed(1)} KB`);
  return buf.toString("utf8");
}

let css = "";
for (const f of FILES) {
  const body = await download(f.url, f.out);
  if (f.out.endsWith(".css")) css = body;
}

// KaTeX 的 CSS 会引用 fonts/*.woff2，一并抓下来，保证离线数学公式渲染
const fontRefs = [...new Set([...css.matchAll(/url\((fonts\/[^)"']+)\)/g)].map((m) => m[1]))];
console.log(`KaTeX 字体引用 ${fontRefs.length} 个`);
let done = 0;
const queue = [...fontRefs];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const ref = queue.shift();
      try {
        await download(`${CDN}/katex@0.16.11/dist/${ref}`, `katex/${ref}`);
        done++;
      } catch (e) {
        console.log(`font FAIL ${ref}: ${e.message}`);
      }
    }
  })
);
console.log(`字体完成 ${done}/${fontRefs.length}`);
console.log("vendor 目录:", vendor);
