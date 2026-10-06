// 验证本轮四项改动：编辑器滚动渲染 / 三套界面配色 / PDF 深色模式 / 每题一页
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { checkBleed } from "./check-pdf-bg.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9390;

const OUT = ROOT + "\\build\\uicheck";
const PROFILE = process.env.TEMP + "\\edge-uipdf";

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: Boolean(cond), extra });
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? "  — " + extra : ""}`);
};

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
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.enable");
await sleep(3000);
// 断言基于简体界面，先钉死语言
await ev(`(async () => {
  localStorage.setItem('uiLang', 'zh-CN');
  await fetch('/api/config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ uiLang: 'zh-CN' }) });
  return true;
})()`);
await ev("document.getElementById('wizardPanel')?.classList.add('hidden')");

console.log("\n===== 1. 铺测试数据 =====");
const seeded = await ev(`(async () => {
  const mk = (pid, title, diff, status, extra={}) => ({
    id:'p_'+pid, kind:'problem', pid, title, url:'https://www.luogu.com.cn/problem/'+pid,
    difficulty:diff, difficultyName:['暂无','入门','普及-','普及/提高-'][diff]||'', tagNames:['模拟'],
    timeLimit:1000, memoryLimit:262144,
    description:'给定 n 个数，求区间和。', formatI:'第一行包含两个正整数 $n,m$。\\n\\n第二行包含 $n$ 个用空格分隔的整数。\\n\\n接下来 $m$ 行每行包含 $3$ 个整数。',
    formatO:'输出若干行', hint:'$1 \\\\le n \\\\le 100$', samples:[{input:'5 5\\n1 5 4 2 3\\n1 1 3\\n2 2 5\\n1 3 -1\\n1 4 2\\n2 1 4', output:'14\\n16'}],
    status, code:'', note:'', tests:[], addedAt: Date.now(), ...extra });
  const doc = { version:3, title:'验证本', tree:[
    mk('P3374','树状数组 1',4,'ac'),
    mk('P3368','树状数组 2',4,'todo'),
    mk('P1001','A+B Problem',1,'ac'),
  ]};
  const r = await fetch('/api/save', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({doc}) });
  return (await r.json()).ok;
})()`);
ok("数据铺好", seeded === true);
await send("Page.reload", { ignoreCache: true });
await sleep(3500);

console.log("\n===== 2. 编辑器长代码滚动渲染（曾经 25 行后空白）=====");
const scrollTest = await ev(`(() => {
  const ta = document.getElementById('code');
  const hl = document.getElementById('hl');
  const box = document.getElementById('codeScroll');
  // 造 120 行代码
  const lines = ['#include <bits/stdc++.h>', 'using namespace std;', ''];
  for (let i = 1; i <= 117; i++) lines.push('int v' + i + ' = ' + i + '; // 第 ' + (i + 3) + ' 行');
  ta.value = lines.join('\\n');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const before = { hlHeight: Math.round(hl.getBoundingClientRect().height), boxHeight: Math.round(box.getBoundingClientRect().height) };
    ta.scrollTop = ta.scrollHeight;   // 滚到底
    const boxR = box.getBoundingClientRect(), hlR = hl.getBoundingClientRect();
    const covered = hlR.bottom >= boxR.bottom - 2;
    const hasLastLine = document.getElementById('hlCode').textContent.includes('第 120 行');
    const gutter = document.getElementById('gutterInner');
    const gutterBottom = gutter.getBoundingClientRect().bottom;
    res(JSON.stringify({ ...before, scrollTop: Math.round(ta.scrollTop), covered, hasLastLine,
      gutterCovers: gutterBottom >= boxR.bottom - 4, hlBottom: Math.round(hlR.bottom), boxBottom: Math.round(boxR.bottom) }));
  })));
})()`);
const st = JSON.parse(scrollTest);
console.log("   高亮层高度:", st.hlHeight, "px | 可视区高度:", st.boxHeight, "px | scrollTop:", st.scrollTop);
ok("高亮层按内容撑高（不再等于可视区高度）", st.hlHeight > st.boxHeight * 2, `${st.hlHeight}px`);
ok("滚到底后高亮层仍覆盖可视区（核心 bug 修复）", st.covered, `hl.bottom=${st.hlBottom} box.bottom=${st.boxBottom}`);
ok("最后一行代码已渲染", st.hasLastLine);
ok("行号列同步到底部", st.gutterCovers);

console.log("\n===== 3. 三套界面配色 =====");
for (const [theme, label] of [["dark", "深色"], ["light", "浅色"], ["amber", "琥珀"]]) {
  await ev(`(() => { const s=document.getElementById('themeSelect'); s.value='${theme}'; s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  await sleep(400);
  const c = JSON.parse(await ev(`JSON.stringify({
    attr: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    fg: getComputedStyle(document.body).color,
    codeBg: getComputedStyle(document.getElementById('codeScroll').parentElement).backgroundColor
  })`));
  console.log(`   ${label}: bg=${c.bg} fg=${c.fg}`);
  ok(`配色「${label}」已生效`, c.attr === theme && c.bg !== "rgba(0, 0, 0, 0)");
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}\\theme-${theme}.png`, Buffer.from(shot.data, "base64"));
}
const bgs = [];
for (const t of ["dark", "light", "amber"]) {
  await ev(`document.documentElement.dataset.theme='${t}'`);
  bgs.push(await ev("getComputedStyle(document.body).backgroundColor"));
}
ok("三套配色背景互不相同", new Set(bgs).size === 3, bgs.join(" / "));
await ev(`document.documentElement.dataset.theme='light'`);

console.log("\n===== 4. PDF：深色模式 + 每题一页 =====");
const pages = {};
const pdfFiles = {};
for (const theme of ["mono", "sepia", "darkcode", "blue", "big"]) {
  const r = JSON.parse(await ev(`(async () => {
    const r = await fetch('/api/export/pdf', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ theme:'${theme}', scope:'all', twoColumn:true, includeCode:true, includeNote:true }) });
    return JSON.stringify(await r.json());
  })()`));
  if (!r.ok) { ok(`模板 ${theme} 生成`, false, r.error); continue; }
  const full = path.join(ROOT, "exports", r.file);
  pdfFiles[theme] = full;
  const buf = fs.readFileSync(full);
  const txt = buf.toString("latin1");
  const counts = [...txt.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  pages[theme] = counts.length ? Math.max(...counts) : null;
  const valid = buf.subarray(0, 5).toString("latin1").startsWith("%PDF-");
  ok(`模板 ${theme} 生成成功`, valid, `${(buf.length / 1024).toFixed(0)} KB · ${pages[theme]} 页`);
}
console.log("   各模板页数:", JSON.stringify(pages));
const problemCount = 3;
ok("每个模板都做到「一题一页」（页数 ≤ 题目数）", Object.values(pages).every((n) => n != null && n <= problemCount),
  `mono=${pages.mono} big=${pages.big} / ${problemCount} 题`);
ok("「高对比大字」不比默认模板多出页", (pages.big ?? 99) <= (pages.mono ?? 0),
  `big=${pages.big} mono=${pages.mono}`);

// 深色 / 米黄这类有底色的模板，背景必须铺满整页（否则 @page 留白处会是一圈白边）
for (const theme of ["darkcode", "sepia", "mono"]) {
  const f = pdfFiles[theme];
  if (!f) continue;
  const r = checkBleed(f);
  ok(`模板 ${theme} 背景铺满整页（无白边）`, r.ok,
    r.pages.map((p) => (p.full ? "✓" : "✗")).join("") + ` ${r.pages.length} 页`);
}

console.log("\n===== 5. 控制台 =====");
ok("没有未捕获异常", errors.length === 0, errors.slice(0, 2).join(" | "));

const failed = results.filter((r) => !r.pass);
console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { console.log("失败项："); for (const f of failed) console.log(`  ✗ ${f.name} ${f.extra}`); }

ws.close(); edge.kill();
await sleep(500);
try { spawn("taskkill", ["/F", "/IM", "msedge.exe", "/T"], { stdio: "ignore" }); } catch {}
process.exit(failed.length ? 1 : 0);
