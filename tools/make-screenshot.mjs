// 生成展示素材：界面截图 + 样例 PDF（需要服务已在 8765 运行）
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const PORT = 9380;
const OUT = ROOT + "\\docs";
const PROFILE = process.env.TEMP + "\\edge-shot3";

fs.mkdirSync(OUT, { recursive: true });
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1700,1000", "http://127.0.0.1:8765/",
], { stdio: "ignore", windowsHide: true });

let target = null;
for (let i = 0; i < 80 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page" && t.url.includes("8765"));
  } catch {}
  if (!target) await new Promise((r) => setTimeout(r, 300));
}
if (!target) { console.log("连不上浏览器"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

await send("Page.enable");
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 3000));
await ev("document.getElementById('wizardPanel')?.classList.add('hidden')");

// 选中一道有代码的题，跑一遍样例，让结果面板也有内容
await ev(`[...document.querySelectorAll('#outline .row.problem')].find(r=>r.textContent.includes('P3374'))?.click()`);
await new Promise((r) => setTimeout(r, 700));
await ev("document.getElementById('judgeBtn')?.click()");
await new Promise((r) => setTimeout(r, 5000));

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(`${OUT}\\screenshot.png`, Buffer.from(shot.data, "base64"));
console.log("界面截图:", (fs.statSync(`${OUT}\\screenshot.png`).size / 1024).toFixed(0), "KB");

const info = JSON.parse(await ev(`(async () => {
  const r = await fetch('/api/export/pdf', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ theme:'mono', scope:'all', twoColumn:true, includeCode:true, includeNote:true }) });
  return JSON.stringify(await r.json());
})()`));
if (info.ok) {
  fs.copyFileSync(`${ROOT}\\exports\\${info.file}`, `${OUT}\\sample-export.pdf`);
  console.log("样例 PDF:", (info.size / 1024).toFixed(0), "KB → docs/sample-export.pdf");
} else {
  console.log("PDF 生成失败:", info.error);
}

// 再来一份深色模式的 PDF 样例（展示新配色）
const dark = JSON.parse(await ev(`(async () => {
  const r = await fetch('/api/export/pdf', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ theme:'darkcode', scope:'all', twoColumn:true, includeCode:true, includeNote:true }) });
  return JSON.stringify(await r.json());
})()`));
if (dark.ok) {
  fs.copyFileSync(`${ROOT}\\exports\\${dark.file}`, `${OUT}\\sample-dark.pdf`);
  console.log("深色样例:", (dark.size / 1024).toFixed(0), "KB → docs/sample-dark.pdf");
}

// 英文界面下的 PDF 样例（展示多语言）
const enPdf = JSON.parse(await ev(`(async () => {
  const r = await fetch('/api/export/pdf', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ theme:'mono', scope:'all', twoColumn:true, includeCode:true, includeNote:true, lang:'en' }) });
  return JSON.stringify(await r.json());
})()`));
if (enPdf.ok) {
  fs.copyFileSync(`${ROOT}\\exports\\${enPdf.file}`, `${OUT}\\sample-en.pdf`);
  console.log("英文样例:", (enPdf.size / 1024).toFixed(0), "KB → docs/sample-en.pdf");
}

ws.close(); edge.kill();
await new Promise((r) => setTimeout(r, 500));
