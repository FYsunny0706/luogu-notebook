// PDF 目录页 + 书签 自测：目录块/锚点/顺序、toc:false、PDF 页数、书签大纲
// 用法：node tools/test-toc.mjs（会自己起临时服务渲染，不需要先启动主服务）
// 目录页 + 书签 的验收：
//  · 目录页存在、每道题都有一条、且都是指向题目锚点的内部链接
//  · 题目 anchor（id="p-N"）真的存在，序号与目录顺序一致
//  · 生成 PDF：第 1 页是目录、页数合理、**有书签大纲**
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildPrintHtml, renderPdf, putPrintPage, getPrintPage } from "../lib/pdf.mjs";
import { load, flattenProblems } from "../lib/store.mjs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PDF = path.resolve("build/toc-test.pdf");
const CDP_PORT = 9399;

const results = [];
const ok = (name, cond, extra = "") => { results.push(Boolean(cond)); console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`); };

const doc = load();
const probs = flattenProblems(doc.tree);
console.log("===== 1. 打印 HTML 里的目录与锚点 =====");
const html = await buildPrintHtml({ doc, theme: "mono", scope: "all", includeCode: true, includeNote: true, lang: "zh-CN", toc: true });
ok("有目录块", /class="toc"/.test(html));
ok("目录标题是「目录」", /class="toc-title">目录</.test(html));
const hrefs = [...html.matchAll(/<li><a href="#(p-\d+)"/g)].map((m) => m[1]);
const anchors = [...html.matchAll(/<section class="problem" id="(p-\d+)"/g)].map((m) => m[1]);
console.log(`    目录条目 ${hrefs.length} 条；题目锚点 ${anchors.length} 个`);
ok("目录条目数 = 题目数", hrefs.length === probs.length, `${hrefs.length} / ${probs.length}`);
ok("锚点数 = 题目数", anchors.length === probs.length, `${anchors.length} / ${probs.length}`);
ok("每个目录链接都有对应锚点", hrefs.every((h) => anchors.includes(h)));
ok("链接和锚点顺序一致", hrefs.join(",") === anchors.join(","));
ok("不出现页码占位列", !/class="toc-p"/.test(html));

console.log("\n===== 2. 不带目录时没有目录块 =====");
const htmlNoToc = await buildPrintHtml({ doc, theme: "mono", scope: "all", includeCode: true, includeNote: true, lang: "zh-CN", toc: false });
ok("toc:false 时不生成目录", !/class="toc"/.test(htmlNoToc) && /class="problem"/.test(htmlNoToc));

console.log("\n===== 3. 渲染 PDF =====");
const token = putPrintPage(html);
const root = process.cwd();
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u.startsWith("/print/")) {
    const h = getPrintPage(u.slice("/print/".length));
    if (!h) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(h);
  }
  const fp = path.join(root, "public", u.replace(/^\//, ""));
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end("nf"); }
  const ext = path.extname(fp);
  res.writeHead(200, { "content-type": ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => srv.listen(8791, "127.0.0.1", r));
const r = await renderPdf({ url: `http://127.0.0.1:8791/print/${token}`, outPath: PDF });
srv.close();
console.log(`    PDF: ${(r.size / 1024).toFixed(0)} KB`);
const raw = fs.readFileSync(PDF).toString("latin1");
const pageCount = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
ok("页数合理（题目每页 1-2 道）", pageCount >= Math.ceil(probs.length / 2) && pageCount <= probs.length + 3, `${pageCount} 页 / ${probs.length} 题`);

console.log("\n===== 4. PDF 书签 =====");
const om = /\/Type\s*\/Outlines[^>]*?\/Count\s+(\d+)/.exec(raw) ?? /\/Count\s+(\d+)[^>]*?\/Type\s*\/Outlines/.exec(raw);
console.log(`    Outlines: ${/\/Type\s*\/Outlines/.test(raw) ? "有" : "无"}；条目数 ${om ? om[1] : "(未读到)"}`);
ok("有书签大纲", /\/Type\s*\/Outlines/.test(raw));
ok("书签条目数 > 0", om ? Number(om[1]) > 0 : false, om ? `${om[1]} 条` : "");
ok("书签数 ≥ 题目数（含分组的标题）", om ? Number(om[1]) >= probs.length : false, om ? `${om[1]} ≥ ${probs.length}` : "");

const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "✅" : "❌"} 目录/书签验收 ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
