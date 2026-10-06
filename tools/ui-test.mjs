// 端到端测试 v3：无头 Edge + CDP
// 覆盖：文件夹树 / 多选与框选 / 无确认删除+撤销 / 测试点 / 编译错误跳转 /
//       格式化 / 多档案 / 分享卡片 / PDF / 首次运行向导
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9370;
const URL_APP = "http://127.0.0.1:8765/";

const OUT = ROOT + "\\build\\uicheck";
const PROFILE = process.env.TEMP + "\\edge-ui3";

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
  "--window-size=1700,1000", URL_APP,
], { stdio: "ignore", windowsHide: true });

async function waitForTarget(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:8765"));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("连不上 Edge 调试端口（多半是沙箱拦住了浏览器）");
}

const target = await waitForTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const dialogs = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  }
  if (m.method === "Runtime.exceptionThrown") {
    pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
  if (m.method === "Page.javascriptDialogOpening") {
    dialogs.push(m.params.message);
    send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
  }
};

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expression, timeoutMs = 30000, label = "") {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await evaluate(expression)) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`等待超时: ${label || expression}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.enable");

// 下面的断言都基于简体中文界面，先把语言钉死，避免上一次运行留下的语言影响结果
await waitFor("typeof getLang === 'function'", 15000, "i18n 运行时");
await evaluate(`(async () => {
  localStorage.setItem('uiLang', 'zh-CN');
  await fetch('/api/config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ uiLang: 'zh-CN' }) });
  return true;
})()`);
if ((await evaluate("getLang()")) !== "zh-CN") {
  await send("Page.reload", { ignoreCache: true });
  await sleep(2500);
}

console.log("\n===== 1. 首次运行向导 =====");
await waitFor("document.getElementById('wizardPanel') !== null", 15000, "页面加载");
await sleep(900);
const firstRun = await evaluate("Boolean(S.env && S.env.firstRun)");
if (firstRun) {
  ok("首次运行自动弹出向导", await evaluate("!document.getElementById('wizardPanel').classList.contains('hidden')"));
} else {
  // 不是首次运行（config 里已经记过 wizardDone），手动开一次验证向导本身可用
  await evaluate("showWizard()");
  await sleep(400);
  ok("可手动打开环境向导（非首次运行时）", await evaluate("!document.getElementById('wizardPanel').classList.contains('hidden')"));
}
const wizText = await evaluate("document.getElementById('wizardBody').textContent");
ok("向导列出环境项", wizText.includes("C++ 编译器") && wizText.includes("PDF 渲染浏览器"));
ok("向导显示版本号", /v\d+\.\d+\.\d+/.test(wizText), (wizText.match(/v\d+\.\d+\.\d+/) ?? [""])[0]);
await evaluate("document.getElementById('wizClose').click()");
await sleep(300);
ok("可以关闭向导", await evaluate("document.getElementById('wizardPanel').classList.contains('hidden')"));

console.log("\n===== 2. 加载测试数据 =====");
const seeded = await evaluate(`(async () => {
  const st = await fetch('/api/state').then(r=>r.json());
  const mk = (pid, title, diff, status, folder) => ({});
  return true;
})()`);
// 通过 API 直接铺一份树，避免依赖界面抓题
const setup = await evaluate(`(async () => {
  const mkProblem = (pid, title, diff, status, extra={}) => ({
    id: 'p_'+pid, kind:'problem', pid, title,
    url: 'https://www.luogu.com.cn/problem/'+pid,
    difficulty: diff, difficultyName: ['暂无','入门','普及-','普及/提高-','普及+/提高','提高+/省选-'][diff] || '',
    tagNames: ['模拟'], timeLimit: 1000, memoryLimit: 262144,
    description: pid+' 的题目描述，求两个数之和。', formatI: '两个整数 a b', formatO: '一个整数',
    hint: '数据范围：$1\\\\le a,b\\\\le 100$', samples: [{input:'20 30\\n', output:'50\\n'}],
    status, code:'', note:'', tests:[], addedAt: Date.now(), ...extra,
  });
  const doc = { version:3, title:'端到端测试本', tree: [
    { id:'f1', kind:'folder', name:'基础算法', collapsed:false, children:[
      { id:'f1a', kind:'folder', name:'模拟', collapsed:false, children:[
        mkProblem('P1001','A+B Problem',1,'ac',{ code:'#include <bits/stdc++.h>\\nusing namespace std;\\nint main(){ long long a,b; cin>>a>>b; cout<<a+b<<endl; return 0; }' }),
        mkProblem('P1909','买铅笔',1,'todo'),
      ]},
      mkProblem('P1048','采药',2,'review'),
    ]},
    { id:'f2', kind:'folder', name:'数据结构', collapsed:false, children:[
      mkProblem('P3374','树状数组 1',4,'ac'),
      mkProblem('P3368','树状数组 2',4,'todo'),
    ]},
  ]};
  const r = await fetch('/api/save', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({doc}) });
  return (await r.json()).ok;
})()`);
ok("测试数据铺好", setup === true);
await send("Page.reload", { ignoreCache: true });
await sleep(3500);
await waitFor("document.querySelectorAll('#outline .row').length > 0", 15000, "树渲染");

console.log("\n===== 3. 文件夹树 =====");
ok("文件夹行 3 个", await evaluate("document.querySelectorAll('#outline .row.folder').length") === 3,
  String(await evaluate("document.querySelectorAll('#outline .row.folder').length")));
ok("题目行 5 个", await evaluate("document.querySelectorAll('#outline .row.problem').length") === 5);
ok("档案下拉已填充", await evaluate("document.getElementById('profileSelect').options.length") >= 1,
  await evaluate("document.getElementById('profileSelect').selectedOptions[0]?.textContent"));

console.log("\n===== 4. 多选与批量操作 =====");
await evaluate(`[...document.querySelectorAll('#outline .row.problem')].find(r=>r.textContent.includes('P1001')).click()`);
await sleep(300);
ok("单击选中 1 项", await evaluate("S.selected.size") === 1, `已选 ${await evaluate("S.selected.size")}`);
await evaluate(`(() => {
  const row = [...document.querySelectorAll('#outline .row.problem')].find(r=>r.textContent.includes('P1048'));
  const e = new MouseEvent('click', { bubbles:true, cancelable:true, ctrlKey:true });
  row.dispatchEvent(e);
  return true;
})()`);
await sleep(300);
ok("Ctrl+点击累加选中", await evaluate("S.selected.size") === 2, `已选 ${await evaluate("S.selected.size")}`);
ok("批量条出现", await evaluate("!document.getElementById('batchBar').classList.contains('hidden')"));
ok("批量条显示数量", (await evaluate("document.getElementById('batchCount').textContent")).includes("2"));

// 框选：在空白处按下，向上拖过若干行
const marquee = await evaluate(`(() => {
  const scroll = document.getElementById('outlineScroll');
  const rows = [...document.querySelectorAll('#outline .row')];
  const sr = scroll.getBoundingClientRect();
  // 从最后一行下方一点开始（空白区）
  const last = rows[rows.length-1].getBoundingClientRect();
  const startY = Math.min(last.bottom + 12, sr.bottom - 6);
  const startX = sr.left + 10;
  const endY = rows[0].getBoundingClientRect().top + 4;
  const fire = (type, target, y) => target.dispatchEvent(new MouseEvent(type, {
    bubbles:true, cancelable:true, clientX: sr.left + 40, clientY: y, button: 0,
  }));
  fire('mousedown', scroll, startY);
  fire('mousemove', window, (startY + endY) / 2);
  fire('mousemove', window, endY);
  fire('mouseup', window, endY);
  return { startY: Math.round(startY), endY: Math.round(endY), selected: S.selected.size };
})()`);
ok("鼠标框选能选中多项", marquee.selected >= 3, `框选后选中 ${marquee.selected} 项`);

console.log("\n===== 5. 无确认删除 + 撤销 =====");
dialogs.length = 0;
const beforeDel = await evaluate("flattenProblems().length");
await evaluate(`(() => {
  // 只留一道题的选中，便于断言
  S.selected.clear();
  const p = flattenProblems().find(x=>x.pid==='P1048');
  S.selected.add(p.id);
  renderOutline();
  document.getElementById('batchDelete').click();
  return true;
})()`);
await sleep(700);
ok("删除时不再弹确认框", dialogs.length === 0, `弹窗数 ${dialogs.length}`);
ok("题目确实被删除", await evaluate("flattenProblems().length") === beforeDel - 1,
  `${beforeDel} → ${await evaluate("flattenProblems().length")}`);
ok("提示里带撤销按钮", await evaluate("!document.getElementById('toastUndo').classList.contains('hidden')"));
await evaluate("document.getElementById('toastUndo').click()");
await sleep(600);
ok("撤销后题目恢复", await evaluate("flattenProblems().length") === beforeDel,
  `恢复到 ${await evaluate("flattenProblems().length")} 题`);

console.log("\n===== 6. 编译错误可点击跳转 =====");
await evaluate(`[...document.querySelectorAll('#outline .row.problem')].find(r=>r.textContent.includes('P1001')).click()`);
await sleep(400);
await evaluate(`(() => {
  const ta = document.getElementById('code');
  ta.value = '#include <bits/stdc++.h>\\nint main() {\\n    int a = ;\\n    return 0;\\n}';
  ta.dispatchEvent(new Event('input', { bubbles:true }));
  return true;
})()`);
await evaluate("document.getElementById('judgeBtn').click()");
await waitFor("!document.getElementById('resultBody').textContent.includes('正在编译运行')", 45000, "编译");
ok("编译错误里有可点击的跳转链接", await evaluate("document.querySelectorAll('#resultBody .jump').length") > 0,
  `${await evaluate("document.querySelectorAll('#resultBody .jump').length")} 个链接 · ${(await evaluate("document.getElementById('resultBody').textContent")).replace(/\s+/g, " ").slice(0, 90)}`);
const jumpLine = await evaluate("document.querySelector('#resultBody .jump')?.dataset.line");
await evaluate("document.querySelector('#resultBody .jump').click()");
await sleep(300);
const caretLine = await evaluate(`(() => {
  const ta = document.getElementById('code');
  return ta.value.slice(0, ta.selectionStart).split('\\n').length;
})()`);
ok("点击后光标跳到对应行", Number(caretLine) === Number(jumpLine), `跳到第 ${caretLine} 行（报错在第 ${jumpLine} 行）`);

console.log("\n===== 7. 测试点 =====");
// 恢复成能通过的代码
await evaluate(`(() => {
  const ta = document.getElementById('code');
  ta.value = '#include <bits/stdc++.h>\\nusing namespace std;\\nint main(){ long long a,b; cin>>a>>b; cout<<a+b<<endl; return 0; }';
  ta.dispatchEvent(new Event('input', { bubbles:true }));
  document.getElementById('stdin').value = '1 2\\n';
  document.getElementById('expected').value = '3\\n';
  return true;
})()`);
await evaluate("document.getElementById('addTest').click()");
await sleep(400);
ok("测试点标签有计数", await evaluate("document.getElementById('tabTestCount').textContent") === "1",
  await evaluate("document.getElementById('tabTestCount').textContent"));
ok("测试点列表出现一条", await evaluate("document.querySelectorAll('.tp-item').length") === 1);
// 再加一个会失败的测试点
await evaluate(`(() => {
  document.getElementById('stdin').value = '2 2\\n';
  document.getElementById('expected').value = '999\\n';
  document.getElementById('addTest').click();
  return true;
})()`);
await sleep(300);
ok("加入第二个测试点", await evaluate("document.querySelectorAll('.tp-item').length") === 2);
await evaluate("document.getElementById('runAllTests').click()");
await waitFor("document.getElementById('testsSummary').textContent.includes('通过')", 45000, "全部测试");
const summary = await evaluate("document.getElementById('testsSummary').textContent");
ok("全部测试给出通过数", /通过\s*1\s*\/\s*2/.test(summary), summary);
ok("失败的点标了 WA", await evaluate("[...document.querySelectorAll('.tp-verdict')].some(e=>e.textContent==='WA')"),
  await evaluate("[...document.querySelectorAll('.tp-verdict')].map(e=>e.textContent).join(',')"));

console.log("\n===== 9. 格式化（未安装时应友好提示）=====");
await evaluate("document.getElementById('formatBtn').click()");
await sleep(900);
const fmtToast = await evaluate("document.getElementById('toastText').textContent");
ok("格式化给出可读提示", fmtToast.includes("clang-format"), fmtToast.slice(0, 80));

console.log("\n===== 10. 多档案 =====");
await evaluate("document.getElementById('settingsBtn').click()");
await sleep(400);
ok("设置里有档案管理", await evaluate("document.querySelectorAll('#profileList .profile-row').length") >= 1);
const beforeProfiles = await evaluate("S.profiles.list.length");
await evaluate(`(async () => {
  const r = await fetch('/api/profile/create', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({name:'第二个档案'}) });
  const j = await r.json();
  S.profiles = j.profiles;
  await reloadDoc();
  renderProfileManager();
  return true;
})()`);
await sleep(800);
ok("可以新建并切换档案", await evaluate("S.profiles.list.length") === beforeProfiles + 1,
  `${beforeProfiles} → ${await evaluate("S.profiles.list.length")}`);
ok("新档案是空的", await evaluate("flattenProblems().length") === 0);
// 切回测试本
await evaluate(`(async () => {
  const list = S.profiles.list.find(x => x.name !== '第二个档案');
  await switchProfile(list.id);
  return true;
})()`);
await sleep(900);
ok("切回后题目还在", await evaluate("flattenProblems().length") === 5,
  `${await evaluate("flattenProblems().length")} 题`);
await evaluate("document.getElementById('settingsPanel').classList.add('hidden')");

console.log("\n===== 11. 分享卡片 =====");
const share = await evaluate(`(async () => {
  const p = flattenProblems().find(x=>x.pid==='P1001');
  p.tests = [{id:'t1', name:'示例', input:'1 2\\n', output:'3\\n'}];
  const r = await fetch('/api/problem/export', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({id:p.id}) });
  const j = await r.json();
  if (!j.ok) return JSON.stringify({err:j.error});
  const before = flattenProblems().length;
  const r2 = await fetch('/api/problem/import', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({card:j.card}) });
  const j2 = await r2.json();
  const count = (nodes) => nodes.reduce((a,n)=> a + (n.kind==='problem' ? 1 : count(n.children??[])), 0);
  return JSON.stringify({ file:j.file, hasTests: (j.card.problem.tests??[]).length>0, before, after: j2.ok ? count(j2.doc.tree) : -1 });
})()`);
const sh = JSON.parse(share);
ok("导出分享卡片", !sh.err && /\.json$/.test(sh.file ?? ""), sh.file ?? sh.err);
ok("卡片里带上了测试点", sh.hasTests === true);
ok("能再导入回来", sh.after > sh.before, `${sh.before} → ${sh.after}`);

console.log("\n===== 12. PDF 导出 =====");
await send("Page.reload", { ignoreCache: true });
await sleep(3500);
await evaluate("document.getElementById('pdfBtn').click()");
await sleep(400);
await evaluate("document.getElementById('pdfGo').click()");
await waitFor("document.getElementById('pdfStatus').textContent.includes('已生成') || document.getElementById('pdfStatus').textContent.includes('失败')", 120000, "PDF");
const pdfStatus = await evaluate("document.getElementById('pdfStatus').textContent");
ok("PDF 生成成功", pdfStatus.includes("已生成"), pdfStatus.replace(/\s+/g, " ").slice(0, 100));

console.log("\n===== 13. 控制台 =====");
ok("没有未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
ok("没有 console.error", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(`${OUT}\\v3-ui.png`, Buffer.from(shot.data, "base64"));

const failed = results.filter((r) => !r.pass);
console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { console.log("失败项："); for (const f of failed) console.log(`  ✗ ${f.name} ${f.extra}`); }

ws.close();
edge.kill();
await sleep(600);
try { spawn("taskkill", ["/F", "/IM", "msedge.exe", "/T"], { stdio: "ignore" }); } catch {}
process.exit(failed.length ? 1 : 0);
