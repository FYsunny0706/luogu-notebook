// 一次性生成全部功能预览图（PNG，无头 Edge + CDP）
//  · 同步洛谷那张用【虚拟账号】mock，不出现真实 UID / 用户名
//  · 不出现本机绝对路径（导出目录只显示 exports/）
//  · PDF 版式那张用导出 PDF 的同一份 buildPrintHtml，取整页裁剪
// 用法：先启动服务（默认 8790），再 node tools/make-previews.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { buildPrintHtml, detectBrowser } from "../lib/pdf.mjs";
import { load } from "../lib/store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "docs", "preview");
const APP = process.env.APP_URL ?? "http://127.0.0.1:8790/";
const PORT = 9388;
const PROFILE = path.join(process.env.TEMP ?? ".", "edge-previews");
const DPR = 1.4;
const MOCK = JSON.parse(fs.readFileSync(path.join(root, "build", "mock-sync.json"), "utf8"));

fs.mkdirSync(OUT, { recursive: true });
const EDGE = detectBrowser();
if (!EDGE) { console.error("没找到 Edge/Chrome"); process.exit(1); }

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", `--force-device-scale-factor=${DPR}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1600,1000", APP,
], { stdio: "ignore", windowsHide: true });

let target = null;
for (let i = 0; i < 100 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch {}
  if (!target) await new Promise((r) => setTimeout(r, 300));
}
if (!target) { console.error("连不上无头浏览器"); edge.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++msgId; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Runtime.enable");
await wait(2500);

const results = [];
async function shot(name, { clip, scale = 1, label } = {}) {
  const params = { format: "png" };
  if (clip) { params.clip = { ...clip, scale }; params.captureBeyondViewport = true; }
  const r = await send("Page.captureScreenshot", params);
  const buf = Buffer.from(r.data, "base64");
  const file = path.join(OUT, name);
  fs.writeFileSync(file, buf);
  const kb = Math.round(buf.length / 1024);
  results.push({ name, kb });
  console.log(`  ✓ ${name.padEnd(24)} ${String(kb).padStart(4)} KB   ${label ?? ""}`);
}

// 关掉环境向导、选一道有代码的题
const pick = (pid) => ev(`(() => {
  const rows = [...document.querySelectorAll('#outline .row')];
  const hit = rows.find((r) => (r.querySelector('.o-pid')?.textContent ?? '').trim() === '${pid}');
  if (hit) hit.click();
  return Boolean(hit);
})()`);

await ev("document.getElementById('wizardPanel')?.classList.add('hidden')");

/* ---------- 01 主界面总览（选中带题面图片的题） ---------- */
await pick("P1149");
await wait(1600);                     // 等题面图片下载/解码
await ev("document.querySelector('.md-body img')?.scrollIntoView({block:'center'})");
await wait(600);
await shot("01-overview.png", { label: "主界面总览（题面图片本地化）" });

/* ---------- 02 本地评测 ---------- */
await pick("P3374");
await wait(900);
await ev("document.getElementById('judgeBtn')?.click()");
await wait(6000);
await shot("02-judge.png", { label: "评测样例 AC + 耗时" });

/* ---------- 03 多组测试点 ---------- */
await ev("document.querySelector('#tabs .tab[data-tab=tests]')?.click()");
await wait(500);
await ev("document.getElementById('runAllTests')?.click()");
await wait(8000);
await shot("03-test-cases.png", { label: "多组自测点 AC / WA" });

/* ---------- 04 导出 PDF 对话框 ---------- */
await ev("document.getElementById('pdfBtn')?.click()");
await wait(1500);
await shot("04-export-pdf.png", { label: "导出 PDF：5 套配色" });
await ev("document.querySelector('#pdfPanel .close')?.click()");
await wait(400);

/* ---------- 05 同步洛谷（虚拟账号） ---------- */
// 注意：「拉取数据」这个动作会把 UID 存进本地 config.json，所以先记下原值，拍完还原
const prevUid = await ev(`(async () => {
  const r = await fetch('/api/state');
  return (await r.json()).env?.luoguUid ?? '';
})()`);
await ev(`(() => {
  const mock = ${JSON.stringify(JSON.stringify(MOCK))};
  const orig = window.fetch;
  window.fetch = (url, opts) => String(url).includes('/api/sync/luogu')
    ? Promise.resolve(new Response(mock, { headers: { 'content-type': 'application/json' } }))
    : orig(url, opts);
  return true;
})()`);
await ev("document.getElementById('syncBtn')?.click()");
await wait(700);
await ev(`(() => { const u = document.getElementById('syncUid'); u.value = '${MOCK.user.uid}'; return u.value; })()`);
await ev("document.getElementById('syncFetch')?.click()");
await wait(1800);
await shot("05-sync-luogu.png", { label: "同步洛谷（示例账号）" });
await ev("document.querySelector('#syncPanel .close')?.click()");
await wait(400);
// 还原成用户自己的 UID（虚拟 UID 只用于截图）
await ev(`(async () => {
  await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ luoguUid: ${JSON.stringify(prevUid ?? "")} }) });
  return true;
})()`);
console.log(`  同步面板截图用的是示例账号；已把 UID 还原为 ${prevUid || "（空）"}`);

/* ---------- 06 学习统计 ---------- */
await ev("document.getElementById('statsBtn')?.click()");
await wait(1000);
await shot("06-statistics.png", { label: "学习统计" });
await ev("document.querySelector('#statsPanel .close')?.click()");
await wait(400);

/* ---------- 07 浅色配色 ---------- */
const setSelect = (id, value) => ev(`(() => {
  const el = document.getElementById('${id}');
  if (!el) return false;
  el.value = '${value}';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`);
await setSelect("themeSelect", "light");
await wait(900);
await shot("07-theme-light.png", { label: "浅色配色" });

/* ---------- 08 英文界面 ---------- */
await setSelect("themeSelect", "dark");
await wait(500);
await setSelect("langSelect", "en");
await wait(3500);                     // 语言切换会 reload
await pick("P1149");
await wait(1200);
await shot("08-ui-english.png", { label: "英文界面" });

/* ---------- 恢复界面设置 ---------- */
await setSelect("langSelect", "zh-CN");
await wait(3000);
await setSelect("themeSelect", "dark");
await wait(600);
console.log("  界面设置已恢复：简体中文 / 深色");

/* ---------- 09 导出 PDF 的首页版式（带题面图片，整页裁剪） ---------- */
const doc = load();
// 挑一道带图片的题，只导出它（scope=current 必须给 targetId，否则会出整本）
const withImg = (function find(nodes) {
  for (const n of nodes ?? []) {
    if (n.kind === "problem" && /images\//.test(n.description ?? "")) return n;
    const hit = n.kind === "folder" ? find(n.children) : null;
    if (hit) return hit;
  }
  return null;
})(doc.tree) ?? null;

const html = await buildPrintHtml({
  doc, theme: "darkcode", scope: "current", targetId: withImg?.id ?? null,
  twoColumn: true, includeCode: true, includeNote: true, lang: "zh-CN",
});

const tmpName = "__preview_pdf.html";
fs.writeFileSync(path.join(root, "public", tmpName), html, "utf8");
try {
  await send("Page.navigate", { url: `${APP}${tmpName}` });
  await wait(2600);                   // 等 KaTeX + 图片就绪
  const box = await ev(`(() => {
    const b = document.body.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(b.left), y: 0, width: Math.ceil(b.width), height: Math.ceil(document.documentElement.scrollHeight) });
  })()`);
  const clip = JSON.parse(box);
  await shot("09-exported-pdf.png", { clip, scale: 1.45, label: `导出 PDF 首页版式（${withImg?.pid ?? "示例题"}${/images\//.test(withImg?.description ?? "") ? "，含题面图片" : ""}）` });
} finally {
  fs.rmSync(path.join(root, "public", tmpName), { force: true });
}

console.log(`\n共 ${results.length} 张，输出目录 ${OUT.replace(root, ".")}`);
ws.close();
edge.kill();
await wait(600);
process.exit(0);
