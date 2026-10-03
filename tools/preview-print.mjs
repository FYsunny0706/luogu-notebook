// 视觉验收：把 PDF 用的打印 HTML 渲染出来截图，确认左右分栏和配色
import fs from "node:fs";
import { spawn } from "node:child_process";
import { buildPrintHtml } from "../lib/pdf.mjs";
import { load } from "../lib/store.mjs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ROOT = "C:\\Users\\hzqcw\\Documents\\deepseek-harness\\default-workspace\\luogu-notebook";
const OUT = ROOT + "\\docs";

const doc = load();
const themes = process.argv[2] ? [process.argv[2]] : ["mono", "darkcode"];
let portOffset = 0;

for (const theme of themes) {
  const PORT = 9341 + portOffset++;
  const html = await buildPrintHtml({ doc, theme, scope: "all", twoColumn: true, includeCode: true, includeNote: true });
  const file = `${ROOT}\\public\\_preview.html`;
  fs.writeFileSync(file, html, "utf8");
  console.log(`[${theme}] 打印页 HTML ${(html.length / 1024).toFixed(0)} KB`);

  const profile = process.env.TEMP + `\\edge-prev-${theme}-${Date.now()}`;
  const edge = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1200,1600", `http://127.0.0.1:8765/_preview.html`,
  ], { stdio: "ignore", windowsHide: true });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page" && t.url.includes("_preview"));
    } catch {}
    if (!target) await new Promise((r) => setTimeout(r, 300));
  }
  if (!target) { console.log(`[${theme}] 连不上浏览器`); edge.kill(); continue; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setEmulatedMedia", { media: "print" });
  await send("Emulation.setDeviceMetricsOverride", { width: 794, height: 1123, deviceScaleFactor: 1.5, mobile: false });
  await new Promise((r) => setTimeout(r, 3000));

  const info = JSON.parse(await ev(`JSON.stringify({
    problems: document.querySelectorAll('.problem').length,
    twoCol: document.querySelectorAll('.pbody:not(.one-col)').length,
    codeBlocks: document.querySelectorAll('pre.code').length,
    katex: document.querySelectorAll('.katex').length,
    height: document.body.scrollHeight,
    firstProblemCols: (() => { const b=document.querySelector('.pbody'); if(!b) return null;
      const s=b.querySelector('.stmt'), c=b.querySelector('.code-wrap');
      return s&&c ? { stmtW: Math.round(s.getBoundingClientRect().width), codeW: Math.round(c.getBoundingClientRect().width),
        sameRow: Math.abs(s.getBoundingClientRect().top - c.getBoundingClientRect().top) < 4 } : null; })()
  })`));
  console.log(`[${theme}]`, JSON.stringify(info));

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const png = `${OUT}\\print-${theme}.png`;
  fs.writeFileSync(png, Buffer.from(shot.data, "base64"));
  console.log(`[${theme}] 截图 → ${png} (${(fs.statSync(png).size / 1024).toFixed(0)} KB)`);

  ws.close(); edge.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { spawn("taskkill", ["/F", "/IM", "msedge.exe", "/T"], { stdio: "ignore" }); } catch {}
}
try { fs.rmSync(`${ROOT}\\public\\_preview.html`, { force: true }); } catch {}
console.log("完成");
