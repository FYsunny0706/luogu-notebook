// 验证卡片上的标签只出现一行（隐藏的不算）
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildCardHtml } from "../lib/pdf.mjs";
import { load, flattenProblems } from "../lib/store.mjs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9403;
const results = [];
const ok = (name, cond, extra = "") => { results.push(Boolean(cond)); console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`); };

const doc = load();
const probs = flattenProblems(doc.tree);
const target = probs.find((p) => (p.tagNames ?? []).length >= 2 && JSON.stringify(p).includes("images/"))
  ?? probs.find((p) => (p.tagNames ?? []).length >= 2) ?? probs[0];
console.log(`  题目: ${target.pid} ${target.title}  标签 ${JSON.stringify(target.tagNames ?? [])}`);

const html = await buildCardHtml({ problem: target, theme: "mono", lang: "zh-CN" });
fs.writeFileSync("build/card-chips.html", html, "utf8");

const root = process.cwd();
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/card") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
  if (u.startsWith("/api/image/")) {
    const p = path.join(root, "data", "images", u.slice("/api/image/".length));
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, { "content-type": "image/png" }); return fs.createReadStream(p).pipe(res);
  }
  const f = path.join(root, "public", u.replace(/^\//, ""));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nf"); }
  const ext = path.extname(f);
  res.writeHead(200, { "content-type": ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=${process.env.TEMP}\\edge-chip-test`,
  "--window-size=1100,1400", `http://127.0.0.1:${PORT}/card`,
], { stdio: "ignore", windowsHide: true });
let t = null;
for (let i = 0; i < 100 && !t; i++) {
  try { t = (await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json()).find((x) => x.type === "page"); } catch {}
  if (!t) await new Promise((r) => setTimeout(r, 250));
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.value;
await send("Page.enable"); await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 2500));

const data = JSON.parse(await ev(`JSON.stringify((function () {
  var vis = function (el) { return el.getClientRects().length > 0; };
  var chips = [].slice.call(document.querySelectorAll('.chip'));
  var visible = chips.filter(vis);
  var rows = new Set();
  visible.forEach(function (c) { rows.add(Math.round(c.getBoundingClientRect().top)); });
  return {
    totalChips: chips.length,
    visibleChips: visible.length,
    visibleRows: rows.size,
    headerChips: [].slice.call(document.querySelectorAll('.card-chips .chip')).filter(vis).length,
    pmetaVisible: [].slice.call(document.querySelectorAll('.card-body .pmeta')).filter(vis).length,
    pheadVisible: [].slice.call(document.querySelectorAll('.card-body .phead')).filter(vis).length,
    texts: visible.map(function (c) { return c.textContent.trim(); }),
    height: Math.round(document.body.getBoundingClientRect().height),
    sections: [].slice.call(document.querySelectorAll(".card-body .stmt h4")).filter(vis).map(function (h) { return h.textContent.trim(); }),
    images: [].slice.call(document.querySelectorAll(".card-body .stmt img")).filter(vis).length,
    codeVisible: [].slice.call(document.querySelectorAll(".card-body pre.code")).filter(vis).length,
    codeBg: (function () { var el = document.querySelector(".card-body pre.code"); return el ? getComputedStyle(el).backgroundColor : "none"; })()
  };
})())`));

console.log(`    卡片里 chip 元素总数: ${data.totalChips}（其中可见 ${data.visibleChips}）`);
console.log(`    可见标签: ${JSON.stringify(data.texts)}`);
console.log(`    标签只占 ${data.visibleRows} 行`);
ok(".pmeta 已被隐藏", data.pmetaVisible === 0, `${data.pmetaVisible} 个可见`);
ok(".phead 已被隐藏（不重复标题）", data.pheadVisible === 0);
ok("可见标签只来自卡片头部", data.visibleChips === data.headerChips, `${data.visibleChips} vs 头部 ${data.headerChips}`);
ok("标签没有重复出现（难度/算法各一次）", (() => {
  const seen = new Map();
  for (const t of data.texts) seen.set(t, (seen.get(t) ?? 0) + 1);
  const dup = [...seen.entries()].filter(([, n]) => n > 1);
  return dup.length === 0;
})(), JSON.stringify(data.texts));
ok("可见标签在一行内", data.visibleRows <= 2, `${data.visibleRows} 行`);
console.log(`    题面小节: ${JSON.stringify(data.sections)}  图片 ${data.images} 张  代码底色 ${data.codeBg}`);
ok("题面各段都在（描述/输入/输出/样例）", data.sections.length >= 3, `${data.sections.length} 段`);
ok("题面图片显示出来了", data.images >= 1, `${data.images} 张`);
ok("代码块在，且有浅灰底色", data.codeVisible === 1 && data.codeBg === "rgb(246, 247, 249)", data.codeBg);

srv.close(); ws.close(); edge.kill();
const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "✅" : "❌"} 卡片标签去重 ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
