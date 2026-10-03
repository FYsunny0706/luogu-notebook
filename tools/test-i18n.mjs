// 多语言验收：键一致性 + 实际切换效果 + 切到英文后界面没有漏翻的中文
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = "C:\\Users\\hzqcw\\Documents\\deepseek-harness\\default-workspace\\luogu-notebook";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9410;
const PROFILE = process.env.TEMP + "\\edge-i18n";

const results = [];
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${extra ? "  — " + extra : ""}`);
};

/* ---------- 1. 字典本身 ---------- */
console.log("\n===== 1. 字典一致性 =====");
const build = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-i18n.mjs")], { encoding: "utf8" });
console.log((build.stdout || "").trim().split("\n").map((l) => "   " + l).join("\n"));
if (build.status !== 0) console.log((build.stderr || "").trim());
ok("三种语言的键完全一致且无空翻译", build.status === 0);

const dict = JSON.parse(fs.readFileSync(path.join(ROOT, "locales", "zh-CN.json"), "utf8"));
ok("字典规模可观（覆盖主要界面）", Object.keys(dict).length >= 150, `${Object.keys(dict).length} 条`);

/* ---------- 2. 浏览器里实际切换 ---------- */
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
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
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
await ev("document.getElementById('wizardPanel')?.classList.add('hidden')");

console.log("\n===== 2. 语言下拉框 =====");
const hasSel = await ev("!!document.getElementById('langSelect')");
ok("存在语言下拉框", hasSel);
if (!hasSel) { ws.close(); edge.kill(); process.exit(1); }
const opts = JSON.parse(await ev("JSON.stringify([...document.getElementById('langSelect').options].map(o=>({v:o.value,t:o.textContent})))"));
ok("下拉框有简体/繁体/英文三项", opts.length === 3, opts.map((o) => o.t).join(" / "));

/** 收集界面上的「外壳文案」，排除题目内容（题目本身是中文的） */
const chromeText = `(() => {
  const sels = ['.topbar .tools button','.topbar .add-box button','#paneOutline .pane-title','#paneOutline .pane-actions button',
    '#paneProblem .pane-title','#paneProblem .pane-actions button','#paneCode .pane-title','#paneCode .pane-actions button',
    '.run-bar button','#tabs .tab','.tab-pane[data-pane=io] label','.tests-toolbar button','.result-head','#exportMenu button',
    '#settingsPanel .modal-head h3','#pdfPanel .modal-head h3','#statsPanel .modal-head h3','#mdPanel .modal-head h3','#syncPanel .modal-head h3'];
  return sels.map(s => [...document.querySelectorAll(s)].map(e => e.textContent.trim()).join(' | ')).join(' | ');
})()`;

async function switchLang(v) {
  await ev(`(() => { const s = document.getElementById('langSelect'); s.value = '${v}'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  // 切语言会整页重载，等它稳定下来再把向导关掉
  await sleep(2200);
  try { await ev("document.getElementById('wizardPanel')?.classList.add('hidden')"); } catch {}
  await sleep(300);
}

console.log("\n===== 3. 切换到英文 =====");
await switchLang("en");
const en = await ev(chromeText);
const enHtmlLang = await ev("document.documentElement.lang");
ok("html lang 属性跟着变", enHtmlLang === "en", enHtmlLang);
ok("界面出现英文", /Add|Run|Test|Export|Settings|Problem|Code|Index|Sample/i.test(en));
const cjk = en.match(/[\u4e00-\u9fa5]/g) ?? [];
ok("界面外壳没有漏翻的中文", cjk.length === 0, cjk.length ? `仍有 ${cjk.length} 个汉字：${[...new Set(cjk)].join("")}` : "干净");
ok("没有 JS 报错", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

console.log("\n===== 4. 切换到繁体中文 =====");
await switchLang("zh-TW");
const tw = await ev(chromeText);
const twHtmlLang = await ev("document.documentElement.lang");
ok("html lang 属性是 zh-TW", twHtmlLang === "zh-TW", twHtmlLang);
// 繁体特有字形 / 用词
const twHits = ["設定", "檔案", "匯出", "題目", "測試", "說明", "儲存", "資料", "開啟", "選擇", "刪除", "復原"]
  .filter((w) => tw.includes(w));
ok("出现繁体用词", twHits.length >= 3, twHits.join(" / "));
ok("不再是简体用词", !/设置|导出|题目|测试|删除|撤销/.test(tw), tw.slice(0, 90));

console.log("\n===== 5. 记忆选择 =====");
await sleep(800);
const cfg = JSON.parse(await ev(`fetch('/api/state').then(r=>r.json()).then(j=>JSON.stringify({ lang: j.env.uiLang }))`));
ok("语言选择已存进配置", cfg.lang === "zh-TW", `uiLang = ${cfg.lang}`);
await send("Page.reload", { ignoreCache: true });
await sleep(3000);
await ev("document.getElementById('wizardPanel')?.classList.add('hidden')");
ok("刷新后仍是繁体", (await ev("document.documentElement.lang")) === "zh-TW");

console.log("\n===== 6. 截图 =====");
for (const [v, name] of [["zh-CN", "cn"], ["zh-TW", "tw"], ["en", "en"]]) {
  await switchLang(v);
  await sleep(500);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const dir = path.join(ROOT, "build", "i18n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `ui-${name}.png`), Buffer.from(shot.data, "base64"));
}
console.log("   已存到 build/i18n/ui-{cn,tw,en}.png");
await switchLang("zh-CN");

const failed = results.filter((r) => !r.pass);
console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) for (const f of failed) console.log(`  ✗ ${f.name}`);
ws.close(); edge.kill();
await sleep(400);
try { spawn("taskkill", ["/F", "/IM", "msedge.exe", "/T"], { stdio: "ignore" }); } catch {}
process.exit(failed.length ? 1 : 0);
