// PWA 自测：manifest 合法性（CDP 权威校验）+ service worker 注册 + 静态资源缓存策略
// 用法：先启动服务（默认 8765），再 node tools/test-pwa.mjs
//      APP_URL=http://127.0.0.1:8790/ node tools/test-pwa.mjs   ← 指定别的端口
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const APP = process.env.APP_URL ?? "http://127.0.0.1:8765/";
const PORT = 9392;

const results = [];
const ok = (name, cond, extra = "") => { results.push(Boolean(cond)); console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`); };

/* ---------- 1. 静态资源与缓存头（不经浏览器） ---------- */
console.log("===== 1. 资源可访问性与缓存头 =====");
for (const [p, wantType, wantCache] of [
  ["/manifest.webmanifest", "application/manifest+json", "no-store"],
  ["/sw.js", "text/javascript", "no-store"],
  ["/icons/icon-192.png", "image/png", "no-store"],
  ["/app.js", "text/javascript", "no-store"],
  ["/vendor/marked/marked.min.js", "text/javascript", "max-age"],
]) {
  try {
    const r = await fetch(APP.replace(/\/$/, "") + p);
    const ct = r.headers.get("content-type") ?? "";
    const cc = r.headers.get("cache-control") ?? "";
    console.log(`    ${p.padEnd(30)} HTTP ${r.status}  ${ct.padEnd(38)} ${cc}`);
    ok(`${p} MIME 正确`, ct.includes(wantType.split(";")[0]), ct);
    ok(`${p} 缓存策略正确`, cc.includes(wantCache), cc);
  } catch (e) {
    ok(`${p} 可访问`, false, e.message);
  }
}

/* ---------- 2. 浏览器里的 manifest 与 SW ---------- */
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP}\\edge-pwa-test`,
  "--window-size=1400,900", APP,
], { stdio: "ignore", windowsHide: true });

let target = null;
for (let i = 0; i < 100 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
  if (!target) await new Promise((r) => setTimeout(r, 300));
}
if (!target) { console.error("连不上浏览器"); edge.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable"); await send("Runtime.enable");
await wait(2800);

console.log("\n===== 2. manifest（CDP Page.getAppManifest 权威校验）=====");
let man = null;
try { man = await send("Page.getAppManifest"); } catch (e) { console.log("    getAppManifest 失败:", e.message); }
if (man) {
  console.log(`    url: ${man.url}`);
  const errs = man.errors ?? [];
  ok("manifest 没有错误", errs.length === 0, errs.map((e) => `${e.critical ? "严重" : "警告"}: ${e.message}`).join(" | ") || "无");
  // 不同 Edge 版本：parsed 可能为空，这时自己解析 data（原始 manifest 文本）
  let parsed = man.parsed ?? {};
  if (!parsed.name && man.data) {
    try { parsed = JSON.parse(man.data); } catch { /* 解析失败就用空的 */ }
  }
  console.log(`    name: ${parsed.name} | short_name: ${parsed.short_name} | display: ${parsed.display}`);
  console.log(`    icons: ${(parsed.icons ?? []).map((i) => i.sizes).join(", ")} | start_url: ${parsed.start_url}`);
  ok("名称正确", /洛谷刷题本/.test(parsed.name ?? ""), parsed.name);
  ok("display 是 standalone", parsed.display === "standalone", parsed.display);
  ok("有 192 和 512 图标", (parsed.icons ?? []).some((i) => (i.sizes ?? "").includes("192")) && (parsed.icons ?? []).some((i) => (i.sizes ?? "").includes("512")));
  for (const icon of parsed.icons ?? []) {
    try {
      const r = await fetch(APP.replace(/\/$/, "") + icon.src);
      ok(`图标可访问 ${icon.src}`, r.ok && (r.headers.get("content-type") ?? "").includes("image/png"), `HTTP ${r.status}`);
    } catch (e) { ok(`图标可访问 ${icon.src}`, false, e.message); }
  }
}

console.log("\n===== 3. service worker 注册 =====");
let reg = null;
for (let i = 0; i < 15; i++) {
  reg = await ev(`(async () => {
    if (!('serviceWorker' in navigator)) return 'no-sw-api';
    const r = await navigator.serviceWorker.getRegistration();
    return r ? JSON.stringify({ scope: r.scope, active: Boolean(r.active), state: r.active?.state ?? '' }) : '';
  })()`);
  if (reg && reg !== "no-sw-api" && reg !== "") break;
  await wait(700);
}
console.log(`    注册结果: ${reg || "(空)"}`);
if (reg === "no-sw-api") ok("浏览器支持 SW", false);
else if (!reg) ok("service worker 已注册", false, "没拿到注册对象");
else {
  const r = JSON.parse(reg);
  ok("service worker 已注册", true, `scope=${r.scope}`);
  ok("SW 已激活", r.active, `state=${r.state}`);
}

console.log("\n===== 4. SW 不缓存（fetch 原样放行）=====");
const fresh = await ev(`(async () => {
  const t = Date.now();
  const r = await fetch('/app.js?_=' + t, { cache: 'no-store' });
  return r.status + ':' + (r.headers.get('cache-control') || '');
})()`);
console.log(`    /app.js → ${fresh}`);
ok("静态资源可被 SW 放行", fresh.startsWith("200"), fresh);

const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "✅" : "❌"} PWA 测试 ${pass}/${results.length}`);
ws.close(); edge.kill();
await wait(400);
process.exit(pass === results.length ? 0 : 1);
