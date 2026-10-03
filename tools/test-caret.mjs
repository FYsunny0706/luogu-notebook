// 诊断编辑器光标错位：量一下「高亮层」和「输入层」同一段文字的实际渲染宽度是否一致
// 两层必须逐像素对齐，否则光标（由 textarea 画）就会和高亮文字（由 pre 画）错开
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9400;
const PROFILE = process.env.TEMP + "\\edge-caret";

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1600,900", "http://127.0.0.1:8765/",
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
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.enable");
await sleep(2800);
await ev("document.getElementById('wizardPanel')?.classList.add('hidden')");

const report = await ev(`(() => {
  const ta = document.getElementById('code');
  const pre = document.getElementById('hl');
  const code = document.getElementById('hlCode');
  ta.value = 'int main() { /* 中文注释 abcdefghij */ return 0; }'.repeat(3);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const taCS = getComputedStyle(ta);
    const preCS = getComputedStyle(pre);
    const codeCS = getComputedStyle(code);
    // 用同样的样式各造一个镜子，量同一段文字的宽度
    const measure = (cs) => {
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;white-space:pre;margin:0;padding:0;border:0;';
      d.style.fontFamily = cs.fontFamily;
      d.style.fontSize = cs.fontSize;
      d.style.fontWeight = cs.fontWeight;
      d.style.fontStyle = cs.fontStyle;
      d.style.letterSpacing = cs.letterSpacing;
      d.style.wordSpacing = cs.wordSpacing;
      d.style.fontVariantLigatures = cs.fontVariantLigatures;
      d.style.fontKerning = cs.fontKerning;
      d.textContent = 'x'.repeat(120);
      document.body.appendChild(d);
      const w = d.getBoundingClientRect().width;
      d.remove();
      return Math.round(w * 100) / 100;
    };
    // 高亮层真实首行宽度（有高亮 span 时）
    const realFirstLine = (() => {
      const r = code.getBoundingClientRect();
      return Math.round(r.width * 100) / 100;
    })();
    res(JSON.stringify({
      taFont: taCS.fontFamily, taSize: taCS.fontSize, taWeight: taCS.fontWeight, taStyle: taCS.fontStyle,
      preFont: preCS.fontFamily, preSize: preCS.fontSize,
      codeFont: codeCS.fontFamily, codeSize: codeCS.fontSize, codeStyle: codeCS.fontStyle,
      taWidth120: measure(taCS),
      codeWidth120: measure(codeCS),
      preWidth120: measure(preCS),
      taLetterSpacing: taCS.letterSpacing, codeLetterSpacing: codeCS.letterSpacing,
      taTabSize: taCS.tabSize, codeTabSize: codeCS.tabSize,
    }));
  })));
})()`);

const r = JSON.parse(report);
console.log("=== 输入层 textarea ===");
console.log("  font-family:", r.taFont);
console.log("  size/weight/style:", r.taSize, r.taWeight, r.taStyle, "| letter-spacing:", r.taLetterSpacing, "| tab-size:", r.taTabSize);
console.log("=== 高亮层 pre ===");
console.log("  font-family:", r.preFont);
console.log("=== 高亮层里的 code（真正画字的那层）===");
console.log("  font-family:", r.codeFont);
console.log("  size/style:", r.codeSize, r.codeStyle, "| letter-spacing:", r.codeLetterSpacing, "| tab-size:", r.codeTabSize);
console.log("");
console.log("120 个字符的渲染宽度：");
console.log("  textarea 用:", r.taWidth120, "px");
console.log("  code 用    :", r.codeWidth120, "px");
console.log("  差值       :", Math.round((r.codeWidth120 - r.taWidth120) * 100) / 100, "px");

const same = Math.abs(r.codeWidth120 - r.taWidth120) < 0.5;
console.log("");
console.log(same ? "✓ 两层字体一致（光标不会错位）" : "✗ 两层字体不一致 → 这正是光标错位的原因");

ws.close(); edge.kill();
await sleep(400);
try { spawn("taskkill", ["/F", "/IM", "msedge.exe", "/T"], { stdio: "ignore" }); } catch {}
process.exit(same ? 0 : 1);
