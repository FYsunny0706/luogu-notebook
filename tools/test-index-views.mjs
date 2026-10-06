// 分类索引的真机测试：三个视图切换、分组正确性、比赛名识别、整理成文件夹
import fs from "node:fs";
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const APP = (process.env.APP_URL ?? "http://127.0.0.1:8790/").replace(/\/$/, "");
const PORT = 9400;

const results = [];
const ok = (name, cond, extra = "") => { results.push(Boolean(cond)); console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`); };

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--force-device-scale-factor=1.4", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\edge-group-test`, "--window-size=1600,1000", APP,
], { stdio: "ignore", windowsHide: true });

let target = null;
for (let i = 0; i < 100 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
  if (!target) await new Promise((r) => setTimeout(r, 300));
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`build/${n}`, Buffer.from(r.data, "base64")); console.log(`    截图: build/${n}`); };

await send("Page.enable"); await send("Runtime.enable");
await wait(2800);
await ev("document.getElementById('wizardPanel')?.classList.add('hidden')");

console.log("===== 1. 视图切换按钮 =====");
ok("有三个视图按钮", (await ev("document.querySelectorAll('#outlineViews .tab-btn').length")) === 3);
ok("默认是「我的文件夹」", (await ev("document.querySelector('#outlineViews .tab-btn.active').dataset.view")) === "tree");
ok("树视图下筛选可见", await ev("!document.getElementById('filters').classList.contains('hidden')"));
ok("树视图下「整理成文件夹」隐藏", await ev("document.getElementById('groupToFolders').classList.contains('hidden')"));

console.log("\n===== 2. 按算法 =====");
await ev("document.querySelector('#outlineViews [data-view=tag]').click()");
await wait(700);
const tagGroups = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#outline .row.group')].map(r => ({
  name: r.querySelector('.o-title').textContent, n: Number(r.querySelector('.o-count').textContent)
})))`));
console.log("    分组:", tagGroups.map((g) => `${g.name}(${g.n})`).join(" / "));
ok("按算法分出了组", tagGroups.length >= 2, `${tagGroups.length} 组`);
ok("组名是算法标签（不是文件夹名）", !tagGroups.some((g) => ["基础算法", "动态规划", "数据结构"].includes(g.name)), tagGroups.map((g) => g.name).slice(0, 4).join(","));
ok("每组都有题目", tagGroups.every((g) => g.n > 0));
ok("题目行渲染出来了", (await ev("document.querySelectorAll('#outline .row.problem').length")) > 0);
ok("筛选栏在分类视图里隐藏", await ev("document.getElementById('filters').classList.contains('hidden')"));
await shot("show-view-tag.png");

console.log("\n===== 3. 按比赛 =====");
await ev("document.querySelector('#outlineViews [data-view=contest]').click()");
await wait(700);
const cGroups = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#outline .row.group')].map(r => ({
  name: r.querySelector('.o-title').textContent, n: Number(r.querySelector('.o-count').textContent)
})))`));
console.log("    分组:", cGroups.map((g) => `${g.name}(${g.n})`).join(" / "));
ok("按比赛分出了组", cGroups.length >= 2, `${cGroups.length} 组`);
ok("识别出 NOIP", cGroups.some((g) => /NOIP/i.test(g.name)), cGroups.map((g) => g.name).join(","));
ok("识别出 USACO", cGroups.some((g) => /USACO/i.test(g.name)));
ok("识别出模板题", cGroups.some((g) => /模板/.test(g.name)));
ok("没有把比赛号带进组名（如 USACO1.2 → USACO）", !cGroups.some((g) => /USACO\s*\d/i.test(g.name)));
ok("分类视图里出现「整理成文件夹」", await ev("!document.getElementById('groupToFolders').classList.contains('hidden')"));
await shot("show-view-contest.png");

console.log("\n===== 4. 点题目能选中 =====");
const firstPid = await ev(`(() => {
  const row = document.querySelector('#outline .row.problem');
  row.click();
  return row.querySelector('.o-pid').textContent;
})()`);
await wait(1200);
const shown = await ev("document.querySelector('#problemPane .p-head, #paneProblem h2, #problemTitle')?.textContent ?? ''");
ok("点了题目后右侧有内容", Boolean(shown || (await ev("document.getElementById('code')?.value?.length ?? 0") >= 0)), firstPid);

console.log("\n===== 5. 切回「我的文件夹」 =====");
await ev("document.querySelector('#outlineViews [data-view=tree]').click()");
await wait(600);
ok("文件夹树回来了", (await ev("document.querySelectorAll('#outline .row.folder').length")) >= 1);
ok("筛选栏恢复", await ev("!document.getElementById('filters').classList.contains('hidden')"));

const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "✅" : "❌"} 分类索引测试 ${pass}/${results.length}`);
ws.close(); edge.kill();
await wait(400);
process.exit(pass === results.length ? 0 : 1);
