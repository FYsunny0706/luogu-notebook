// PDF 导出：服务端把文档渲染成定制 HTML，再用系统自带 Edge/Chrome 无头模式
// 直接写成 PDF 文件（不经过浏览器打印对话框）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./judge.mjs";
import { STATUS_LABEL, findNode, flattenProblems } from "./store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_DIR = path.join(root, "exports");
const BUILD_DIR = path.join(root, "build");

/* ---------------- marked：直接复用前端那份 vendor 副本 ---------------- */
// vendor/marked/marked.min.js 是 UMD 包，而本项目 package.json 是 "type": "module"，
// 直接 import() 会把它当 ESM 跑：exports/module/define 三个分支都进不去，
// 结果只挂到 globalThis.marked，模块命名空间是空的 —— 于是 marked.parse 一直抛异常、
// 题面静默退化成未渲染的原始 Markdown（列表、公式、图片全丢）。
// 这里给它一个 CommonJS 环境，让它走 CJS 分支，稳定拿到真正的 marked。
let markedMod = null;
async function getMarked() {
  if (markedMod) return markedMod;
  const file = path.join(root, "public", "vendor", "marked", "marked.min.js");
  if (!fs.existsSync(file)) throw new Error(`缺少 ${file}`);
  const code = fs.readFileSync(file, "utf8");
  const mod = { exports: {} };
  new Function("module", "exports", code)(mod, mod.exports);
  const m = mod.exports;
  if (typeof m?.parse !== "function") throw new Error("vendor/marked 加载失败（解析函数缺失）");
  m.setOptions?.({ gfm: true, breaks: true });
  markedMod = m;
  return markedMod;
}
async function mdToHtml(md) {
  if (!md) return "";
  const marked = await getMarked();
  let html;
  try { html = marked.parse(String(md)); } catch { html = `<p>${escapeHtml(md)}</p>`; }
  // 本地单人工具：只做最低限度清理，防止题面里混入脚本
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+\s*=/gi, " data-x=");
  // 题面图片在数据里是 images/<题号>/<文件>，打印页由本地服务提供，映射到图片路由
  return html.replace(/(src|href)="images\//g, '$1="/api/image/');
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- C++ 语法高亮（PDF 用，纯静态输出） ---------------- */
const CPP_KEY = "alignas|alignof|auto|break|case|catch|class|const|constexpr|continue|decltype|default|delete|do|else|enum|explicit|extern|false|for|friend|goto|if|inline|mutable|namespace|new|noexcept|nullptr|operator|private|protected|public|register|return|sizeof|static|static_assert|struct|switch|template|this|throw|true|try|typedef|typename|union|using|virtual|volatile|while";
const CPP_TYP = "bool|char|double|float|int|long|short|signed|unsigned|void|size_t|string|vector|map|set|pair|queue|stack|deque|priority_queue|unordered_map|unordered_set|array|bitset|tuple|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|ll|ull";

function highlightCpp(code) {
  const rx = new RegExp(
    "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)" +
    "|(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')" +
    "|(^[ \\t]*#[^\\n]*)" +
    "|(\\b\\d[\\w.]*\\b)" +
    `|\\b(?:${CPP_KEY})\\b` +
    `|\\b(?:${CPP_TYP})\\b` +
    "|\\b([A-Za-z_]\\w*)(?=\\s*\\()",
    "gm"
  );
  const cls = ["c-com", "c-str", "c-pre", "c-num", "c-key", "c-typ", "c-fn"];
  let out = "", last = 0, m;
  while ((m = rx.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    const gi = m.slice(1).findIndex((g) => g !== undefined);
    out += `<span class="${cls[gi]}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) rx.lastIndex++;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

/* ---------------- 配色模板 ---------------- */
export const THEMES = {
  mono: { name: "简约黑白", css: `` },
  sepia: {
    name: "护眼米黄",
    css: `:root{--page-bg:#fbf6e9;--fg:#3a3226;--muted:#7a6a52;--line:#ddd0b5;--accent:#8a6d3b;
          --code-bg:#f4ecd8;--code-fg:#3a3226;--chip-bg:#f0e6cf;}
          .problem{border-top-color:#ddd0b5} h1,h2{border-bottom-color:#d8c9a8}`,
  },
  darkcode: {
    name: "深色模式",
    css: `:root{--page-bg:#15181d;--fg:#e6edf3;--muted:#93a1b0;--line:#333c47;--accent:#7cc4ff;
          --code-bg:#0e1116;--code-fg:#d7e0ea;--chip-bg:#232a33;--on-accent:#15181d;}
          .c-com{color:#6b7c8f;font-style:italic}.c-str{color:#a5e075}.c-num{color:#f0a35e}
          .c-key{color:#ff7b9c}.c-typ{color:#5cc8ff}.c-fn{color:#d2b3ff}.c-pre{color:#e5c07b}
          .stmt pre,.sample pre{background:#0e1116;color:#d7e0ea;border-color:#333c47}
          .stmt code{background:#232a33;color:#ffd9a0}
          .stmt blockquote{border-left-color:#4a5563;color:#93a1b0}
          .stmt th,.stmt td{border-color:#333c47}
          .code-head{background:#1d232b;color:#93a1b0;border-bottom-color:#333c47}`,
  },
  blue: {
    name: "蓝调商务",
    css: `:root{--page-bg:#fff;--fg:#12263f;--muted:#5b7290;--line:#c9d8ea;--accent:#1b4f8f;
          --code-bg:#f2f6fb;--code-fg:#12263f;--chip-bg:#e8f0fa;}
          h1{color:#1b4f8f} h2{color:#1b4f8f;border-bottom-color:#1b4f8f;border-bottom-width:1.4pt}
          .phead h3{color:#12263f} .pid{background:#1b4f8f;color:#fff}
          .problem{border-top-color:#c9d8ea}`,
  },
  big: {
    name: "高对比大字",
    css: `:root{--page-bg:#fff;--fg:#000;--muted:#333;--line:#9aa4ae;--accent:#000;
          --base-size:9.9pt;--code-size:8.3pt;--lh:1.6;--code-bg:#f4f5f7;--code-fg:#000;--chip-bg:#eceff2;}
          .phead h3{font-size:12pt}
          .problem{margin-top:2mm;padding-top:1.2mm}
          .stmt h4{margin:1.8mm 0 .8mm}`,
  },
};

/* ---------------- 打印页 HTML ---------------- */
/* 主题变量默认值。PDF 打印页和 PNG 卡片都要用同一份 ——
   否则卡片页只加载主题 CSS 时 --code-bg 会是未定义（透明），黑白主题下代码块就"没有底色"。 */
const ROOT_VARS = `  --page-bg:#ffffff; --fg:#16191d; --muted:#5b6673; --line:#d9dee5; --accent:#2d3b4a;
  --on-accent:#ffffff;
  --code-bg:#f6f7f9; --code-fg:#1f2933; --chip-bg:#f0f1f3;`;

const BASE_CSS = `
* { box-sizing: border-box; }

/* 页边距必须为 0。
   原因：Chrome 打印时会把每一页的内容裁剪到「内容区」，而 @page 的留白不算内容区——
   于是无论背景铺多大（根元素背景、position:fixed 全出血层都试过），都会被裁掉，
   四周永远露出一圈白边。把 @page 边距设成 0，内容区就等于整张纸，背景才能真正铺满。
   视觉上的页边距改由「body 左右内边距 + 每个区块自己的上内边距」提供：
   内边距是元素自己的，分页到哪一页都跟着它，不会被裁。 */
@page { size: A4; margin: 0; }

html { background: var(--page-bg); }
body {
  width: 210mm; margin: 0 auto; padding: 0 9mm;
  background: var(--page-bg);
  print-color-adjust: exact; -webkit-print-color-adjust: exact;
}
:root {
${ROOT_VARS}
  --base-size:8.8pt; --code-size:7pt; --lh:1.45;
  --page-gap: 11mm;   /* 每页顶部的留白，由各区块的 padding-top 提供 */
}
html { margin:0; padding:0; color:var(--fg);
  font-family:"Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  font-size:var(--base-size); line-height:var(--lh); }
body { margin-top:0; }
h1 { font-size:16pt; margin:0 0 1mm; padding-top:var(--page-gap); }
.doc-meta { font-size:7.6pt; color:var(--muted); margin-bottom:3mm; }
h2 { font-size:11.5pt; margin:5mm 0 2mm; padding-top:var(--page-gap);
     padding-bottom:.8mm; border-bottom:.8pt solid var(--accent);
     color:var(--accent); break-after:avoid; page-break-after:avoid; }
h3 { font-size:10.5pt; margin:4mm 0 1.5mm; color:var(--accent); break-after:avoid; }
/* .problem 只负责「分页时不出现在页边」：它自带顶部留白，落到哪一页都成立。
   注意每个 .problem 都要有这层留白——包括第一个：万一它被 break-inside 推到第 2 页，
   少了这层就会贴着纸边。真正的分页单位是里面的 .pinner，自动压缩也只作用在它身上，
   这样页边距不会被一起缩小。 */
.problem { break-inside:avoid; page-break-inside:avoid; padding-top:var(--page-gap); }
.pinner { border-top:.5pt dashed var(--line); padding-top:1.6mm; }
.problem:first-of-type .pinner { border-top:none; }
.phead { display:flex; align-items:baseline; gap:2mm; flex-wrap:wrap; margin-bottom:1mm; }
.phead h3 { margin:0; font-size:11pt; }
.pid { font-family:Consolas,monospace; font-weight:700; background:var(--accent); color:var(--on-accent);
  padding:.2mm 1.4mm; border-radius:1mm; font-size:9pt; }
.pname { font-weight:600; }
.pmeta { display:flex; flex-wrap:wrap; gap:1.2mm; margin:0 0 1.6mm; font-size:7.4pt; color:var(--muted); }
.chip { background:var(--chip-bg); border:.4pt solid var(--line); border-radius:4mm; padding:.1mm 1.6mm; }
.chip.diff { color:#fff; border:none; }
.pbody { display:flex; gap:3.5mm; align-items:flex-start; }
.pbody.one-col { display:block; }
.stmt { flex:1 1 46%; min-width:0; }
.code-wrap { flex:1 1 54%; min-width:0; border:.4pt solid var(--line); border-radius:1mm; overflow:hidden; }
.code-head { font-size:7pt; color:var(--muted); background:var(--chip-bg); padding:.5mm 1.6mm;
  border-bottom:.4pt solid var(--line); font-family:Consolas,monospace; }
.stmt h4 { font-size:9pt; margin:2.5mm 0 1mm; color:var(--accent); }
.stmt h4:first-child { margin-top:0; }
.stmt p { margin:1.2mm 0; }
.stmt ul, .stmt ol { margin:1.2mm 0; padding-left:5mm; }
.stmt li { margin:.4mm 0; }
.stmt pre { background:var(--code-bg); border:.4pt solid var(--line); border-radius:1mm;
  padding:1.2mm 2mm; font-family:Consolas,monospace; font-size:7.2pt; white-space:pre-wrap;
  overflow-wrap:anywhere; margin:1mm 0; }
.stmt code { font-family:Consolas,monospace; font-size:7.8pt; background:var(--code-bg);
  padding:0 .6mm; border-radius:.6mm; }
.stmt pre code { background:none; padding:0; font-size:inherit; }
.stmt blockquote { margin:1.4mm 0; padding:.6mm 2mm; border-left:1.2pt solid var(--line); color:var(--muted); }
.stmt table { border-collapse:collapse; margin:1.4mm 0; }
.stmt th, .stmt td { border:.4pt solid var(--line); padding:.5mm 1.4mm; font-size:7.6pt; }
.stmt img { max-width:100%; }
.sample { margin:1mm 0 1.6mm; }
.sample .cap { font-size:7.2pt; color:var(--muted); margin:.6mm 0 .3mm; }
.sample pre { margin:0; }
pre.code { margin:0; padding:1.2mm 1.8mm; font-family:Consolas,monospace; font-size:var(--code-size);
  line-height:1.34; color:var(--code-fg); background:var(--code-bg); white-space:pre-wrap;
  overflow-wrap:anywhere; }
.c-com{color:#8b98a5;font-style:italic}.c-str{color:#2f8f4e}.c-num{color:#b5560d}
.c-key{color:#a3205a}.c-typ{color:#1c6ea4}.c-fn{color:#6b3fa0}.c-pre{color:#8a6d00}
.stmt .katex { font-size:1em; color:var(--fg); }
.stmt .katex-display { margin:1.4mm 0; }
.empty { color:var(--muted); font-style:italic; }
`;

/* ---------------- 打印页文案（跟随界面语言） ---------------- */
const PDF_TEXT = {
  "zh-CN": {
    diffUnknown: "暂无评定", "status.todo": "未做", "status.ac": "已通过", "status.review": "待复习", "status.stuck": "卡住",
    desc: "题目描述", bg: "题目情景（本题要求写在其中）", formatI: "输入格式", formatO: "输出格式",
    samples: "输入输出样例", hint: "数据范围 / 提示", note: "我的笔记",
    sampleIn: "样例 {n} 输入", sampleOut: "样例 {n} 输出",
    noStatement: "（还没有抓取题面，可在界面里点「重新抓取」）",
    lines: "{n} 行", emptyCodeShort: "空", noCode: "（还没有写代码）",
    emptyBook: "刷题本里还没有题目。", defaultTitle: "我的洛谷刷题本", toc: "目录",
    meta: "导出时间：{time}　·　共 {n} 道题　·　配色：{theme}",
    theme: { mono: "简约黑白", sepia: "护眼米黄", darkcode: "深色模式", blue: "蓝调商务", big: "高对比大字" },
  },
  "zh-TW": {
    diffUnknown: "暫無評定", "status.todo": "未做", "status.ac": "已通過", "status.review": "待複習", "status.stuck": "卡住",
    desc: "題目描述", bg: "題目情境（本題要求寫在其中）", formatI: "輸入格式", formatO: "輸出格式",
    samples: "輸入輸出樣例", hint: "資料範圍 / 提示", note: "我的筆記",
    sampleIn: "樣例 {n} 輸入", sampleOut: "樣例 {n} 輸出",
    noStatement: "（尚未抓取題面，可在介面點「重新抓取」）",
    lines: "{n} 行", emptyCodeShort: "空", noCode: "（尚未撰寫程式碼）",
    emptyBook: "刷題本裡還沒有題目。", defaultTitle: "我的洛谷刷題本", toc: "目錄",
    meta: "匯出時間：{time}　·　共 {n} 道題　·　配色：{theme}",
    theme: { mono: "簡約黑白", sepia: "護眼米黃", darkcode: "深色模式", blue: "藍調商務", big: "高對比大字" },
  },
  en: {
    diffUnknown: "Unrated", "status.todo": "To do", "status.ac": "Accepted", "status.review": "Review", "status.stuck": "Stuck",
    desc: "Description", bg: "Story", formatI: "Input", formatO: "Output",
    samples: "Samples", hint: "Constraints / Hints", note: "My notes",
    sampleIn: "Sample {n} input", sampleOut: "Sample {n} output",
    noStatement: "(Statement not fetched yet — click “Refetch” in the app.)",
    lines: "{n} lines", emptyCodeShort: "empty", noCode: "(no code yet)",
    emptyBook: "This notebook has no problems yet.", defaultTitle: "My Luogu Notebook", toc: "Contents",
    meta: "Exported {time}　·　{n} problems　·　Theme: {theme}",
    theme: { mono: "Mono", sepia: "Sepia", darkcode: "Dark", blue: "Blue", big: "Large print" },
  },
};

function pt(lang, key, vars) {
  const table = PDF_TEXT[lang] ?? PDF_TEXT["zh-CN"];
  let s = table[key];
  if (s === undefined) s = PDF_TEXT["zh-CN"][key];
  if (s === undefined) return key;
  if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
  return s;
}

function problemBlock(p, depth, { twoColumn, includeCode, includeNote, lang = "zh-CN" }, idx = 0) {
  const d = p;
  const diffName = d.difficultyName || pt(lang, "diffUnknown");
  const diffColor = { 0: "#9aa7b4", 1: "#fe4c61", 2: "#f39c11", 3: "#ffc116", 4: "#52c41a", 5: "#3498db", 6: "#9d3dcf", 7: "#0e1d69" }[d.difficulty ?? 0] ?? "#9aa7b4";
  const mem = d.memoryLimit ? `${(d.memoryLimit / 1024).toFixed(0)} MB` : "—";
  const chips = [
    `<span class="chip diff" style="background:${diffColor}">${escapeHtml(diffName)}</span>`,
    ...(d.tagNames ?? []).map((t) => `<span class="chip">${escapeHtml(t)}</span>`),
    `<span class="chip">${escapeHtml(pt(lang, `status.${d.status ?? "todo"}`))}</span>`,
    `<span class="chip">${d.timeLimit ?? "—"} ms / ${mem}</span>`,
  ].join("");

  const stmtParts = [];
  if (d.description) stmtParts.push(`<h4>${pt(lang, "desc")}</h4>${d._descHtml ?? ""}`);
  else if (d.background) stmtParts.push(`<h4>${pt(lang, "bg")}</h4>${d._bgHtml ?? ""}`);
  if (d.formatI) stmtParts.push(`<h4>${pt(lang, "formatI")}</h4>${d._formatIHtml ?? ""}`);
  if (d.formatO) stmtParts.push(`<h4>${pt(lang, "formatO")}</h4>${d._formatOHtml ?? ""}`);
  if ((d.samples ?? []).length) {
    const s = d.samples.map((x, i) => `
      <div class="sample">
        <div class="cap">${pt(lang, "sampleIn", { n: i + 1 })}</div><pre><code>${escapeHtml(x.input)}</code></pre>
        <div class="cap">${pt(lang, "sampleOut", { n: i + 1 })}</div><pre><code>${escapeHtml(x.output)}</code></pre>
      </div>`).join("");
    stmtParts.push(`<h4>${pt(lang, "samples")}</h4>${s}`);
  }
  if (d.hint) stmtParts.push(`<h4>${pt(lang, "hint")}</h4>${d._hintHtml ?? ""}`);
  if (includeNote && d.note) stmtParts.push(`<h4>${pt(lang, "note")}</h4>${d._noteHtml ?? ""}`);
  if (!stmtParts.length) stmtParts.push(`<div class="empty">${pt(lang, "noStatement")}</div>`);

  const codeBlock = includeCode
    ? `<div class="code-wrap"><div class="code-head">C++17 · ${d.code ? pt(lang, "lines", { n: (d.code.match(/\n/g) ?? []).length + 1 }) : pt(lang, "emptyCodeShort")}</div>` +
      `<pre class="code">${d.code ? highlightCpp(d.code) : `<span class="empty">${pt(lang, "noCode")}</span>`}</pre></div>`
    : "";

  return `<section class="problem"${idx ? ` id="p-${idx}"` : ""}><div class="pinner">
  <div class="phead"><h3><span class="pid">${escapeHtml(d.pid)}</span> <span class="pname">${escapeHtml(d.title)}</span></h3></div>
  <div class="pmeta">${chips}<span class="chip">${escapeHtml(d.url ?? "")}</span></div>
  <div class="pbody${twoColumn && includeCode ? "" : " one-col"}">
    <div class="stmt">${stmtParts.join("\n")}</div>
    ${codeBlock}
  </div>
</div></section>`;
}

/** 给题目挂上渲染好的 HTML 片段 */
async function decorate(node) {
  return {
    ...node,
    _descHtml: await mdToHtml(node.description),
    _bgHtml: await mdToHtml(node.background),
    _formatIHtml: await mdToHtml(node.formatI),
    _formatOHtml: await mdToHtml(node.formatO),
    _hintHtml: await mdToHtml(node.hint),
    _noteHtml: await mdToHtml(node.note),
  };
}

/** 递归展开树，生成正文 HTML */
async function nodesToHtml(nodes, depth, opts, stats) {
  const out = [];
  for (const node of nodes ?? []) {
    if (node.kind === "folder") {
      out.push(`<h2>${escapeHtml(node.name)}</h2>`);
      out.push(await nodesToHtml(node.children, depth + 1, opts, stats));
    } else {
      stats.count++;
      out.push(problemBlock(await decorate(node), depth, opts, stats.count));
    }
  }
  return out.join("\n");
}

/** 生成打印页 HTML（KaTeX 在页面里同步渲染后再打印） */
export async function buildPrintHtml({ doc, theme = "mono", scope = "all", targetId = null, twoColumn = true, includeCode = true, includeNote = true, lang = "zh-CN", toc = false }) {
  const stats = { count: 0 };
  const themeCss = THEMES[theme]?.css ?? "";
  const opts = { twoColumn, includeCode, includeNote, lang };
  const uiLang = PDF_TEXT[lang] ? lang : "zh-CN";

  let body = "";
  const hit = scope === "current" && targetId ? findNode(doc.tree ?? [], targetId)?.node : null;
  if (hit?.kind === "problem") {
    stats.count = 1;
    body = problemBlock(await decorate(hit), 1, opts, 1);
  } else if (hit?.kind === "folder") {
    body = `<h2>${escapeHtml(hit.name)}</h2>\n` + (await nodesToHtml(hit.children, 2, opts, stats));
  } else {
    body = await nodesToHtml(doc.tree ?? [], 1, opts, stats);
  }
  if (!stats.count) body = `<div class="empty">${pt(uiLang, "emptyBook")}</div>`;

  // 目录页：收集有标题的题目（同时给每道题一个锚点 id，供回填页码用）
  let tocBlock = "";
  if (toc) {
    const scopeProblems = hit?.kind === "folder" ? (hit.children ?? [])
      : hit?.kind === "problem" ? [hit]
      : (doc.tree ?? []);
    // 目录项做成指向题目锚点的链接：Chrome 打印 PDF 时会转成「内部跳转」，点了直接跳到那道题。
    // 比印页码可靠 —— 浏览器实际分页和脚本推算可能有 ±1 出入，印错页码比不印更糟；
    // 精确的逐题导航交给 PDF 书签（由标题自动生成）。
    const entries = flattenProblems(scopeProblems)
      .map((p, i) => `<li><a href="#p-${i + 1}"><span class="toc-t">${escapeHtml(p.pid)} ${escapeHtml(p.title ?? "")}</span><span class="toc-dots"></span></a></li>`);
    if (entries.length > 1) {
      tocBlock = `<div class="toc"><div class="toc-title">${pt(uiLang, "toc")}</div><ol class="toc-list">${entries.join("")}</ol></div>`;
    }
  }

  const title = doc.title || pt(uiLang, "defaultTitle");
  return `<!DOCTYPE html>
<html lang="${uiLang}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<style>${BASE_CSS}\n${themeCss}\n${TOC_CSS}</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
<div class="doc-meta">${pt(uiLang, "meta", {
    time: new Date().toLocaleString(uiLang === "en" ? "en-US" : uiLang === "zh-TW" ? "zh-TW" : "zh-CN"),
    n: stats.count,
    theme: pt(uiLang, "theme")?.[theme] ?? THEMES[theme]?.name ?? theme,
  })}</div>
${tocBlock}
${body}
<script src="/vendor/katex/katex.min.js"></script>
<script src="/vendor/katex/auto-render.min.js"></script>
<script>
(function () {
  // 每道题自动压缩到一页：量 .pinner 的实际高度，超出可用页高就按比例缩放（最少缩到 55%）
  // 注意量的是 .pinner 而不是 .problem：后者的 padding 是「页边距」，不能跟着一起缩小。
  function fitToOnePage() {
    var PAGE_PX = 1035;   // A4 高 297mm，去掉上下各 11mm 留白后 = 275mm ≈ 1039px，再留点余量
    var MIN = 0.55;
    var list = document.querySelectorAll('.problem .pinner');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      el.style.zoom = '';
      var h = el.getBoundingClientRect().height;
      if (h > PAGE_PX - 6) {
        var r = Math.max(MIN, (PAGE_PX - 6) / h);
        el.style.zoom = String(Math.floor(r * 1000) / 1000);
        el.setAttribute('data-fitted', '1');
      }
    }
  }
  function render() {
    if (window.renderMathInElement) {
      try {
        renderMathInElement(document.body, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\\\[", right: "\\\\]", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\\\(", right: "\\\\)", display: false }
          ],
          throwOnError: false,
          strict: false,
          ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"]
        });
      } catch (e) {}
    }
    fitToOnePage();
    markTocReady();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { fitToOnePage(); markTocReady(); document.title = "rendered"; });
    }
    document.title = "rendered";
  }

  // 目录页只做可点击链接（内部跳转），精确的逐题导航交给 PDF 书签。
  // 这里只标一个「渲染完成」的标记，供外部（CDP 渲染器）等待。
  function markTocReady() {
    if (document.querySelector('.toc-list')) document.documentElement.setAttribute('data-toc-ready', '1');
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
})();
</script>
</body></html>`;
}

/* ---------------- 目录页样式 ---------------- */
const TOC_CSS = `
.toc { break-after:page; page-break-after:always; padding-top:var(--page-gap); }
.toc-title { font-size:13pt; font-weight:700; color:var(--accent); margin:0 0 4mm; }
.toc-list { margin:0; padding:0; list-style:none; }
.toc-list li { display:flex; align-items:baseline; gap:1mm; font-size:9.5pt; margin:0 0 1.6mm;
  break-inside:avoid; page-break-inside:avoid; }
.toc-t { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.toc-dots { flex:1 1 auto; border-bottom:.5pt dotted var(--line); margin:0 1mm 1mm; min-width:4mm; }
.toc-p { flex:0 0 auto; font-family:Consolas,"Courier New",monospace; color:var(--muted); min-width:6mm; text-align:right; }
`;

/* ---------------- 单题分享卡片（渲染成 PNG） ---------------- */

const CARD_CSS = `
/* 卡片把「打印页的一套样式」按网页尺寸复用，所以这里覆盖字号与页边距相关的变量 */
:root { --base-size:15px; --code-size:12.5px; --lh:1.75; --page-gap:0; }
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--page-bg)}
body{width:920px;max-width:920px;padding:34px 38px 26px;color:var(--fg);
  font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB",system-ui,-apple-system,sans-serif;
  font-size:15px;line-height:1.75;-webkit-font-smoothing:antialiased}
.card-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:0 0 10px}
.card-pid{font-family:Consolas,"Courier New",monospace;font-weight:700;font-size:16px;color:var(--accent);
  border:1px solid var(--line);border-radius:6px;padding:1px 8px;background:var(--chip-bg)}
.card-name{font-size:21px;font-weight:700;line-height:1.35}
.card-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px}
.chip{font-size:12px;padding:2px 9px;border-radius:999px;background:var(--chip-bg);color:var(--muted);
  border:1px solid var(--line);white-space:nowrap}
.chip.diff{color:#fff;border-color:transparent;font-weight:700}
/* 卡片里不重复显示题号标题和标签（卡片头部已经渲染过一遍了），也不要在顶部画虚线和页边留白 */
.card-body .problem{padding-top:0;break-inside:auto;page-break-inside:auto;border-top:none}
.card-body .pinner{border-top:none;padding-top:0}
.card-body .phead{display:none}
/* .pmeta 是打印页那排「难度/算法/状态/时限」标签；卡片头部已有同样的一排，必须隐藏，
   否则页面上会出现两行重复的标签。 */
.card-body .pmeta{display:none}
.card-body .pbody{display:block}
.card-body .stmt{font-size:15px}
.card-body .stmt h4{font-size:14px;margin:16px 0 7px;color:var(--accent)}
.card-body .stmt pre,.card-body .sample pre{font-size:12.5px;border-radius:6px}
.card-body .stmt img{max-width:100%;height:auto;border-radius:6px;border:1px solid var(--line);
  background:#fff;padding:4px;margin:6px 0;display:block}
.card-body .code-wrap{margin-top:18px}
.card-body .code-head{font-size:12px;border-radius:8px 8px 0 0}
.card-body pre.code{border-radius:0 0 8px 8px;font-size:12.5px;line-height:1.6;max-height:none}
.card-foot{margin-top:22px;padding-top:12px;border-top:1px solid var(--line);display:flex;
  justify-content:space-between;gap:12px;color:var(--muted);font-size:12px}
.card-foot .u{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

/**
 * 生成「单题图片卡片」的 HTML（给 renderPng 截图用）。
 * 内容 = 题号/标题/难度/标签 + 完整题面（描述、输入输出格式、样例、题面图片）+ 我的代码 + 我的笔记。
 * 直接复用 PDF 的题面渲染，保证跟导出的 PDF 长得一致、图片也能显示。
 */
export async function buildCardHtml({ problem, theme = "darkcode", lang = "zh-CN", twoColumn = false, includeCode = true, includeNote = true }) {
  const p = problem;
  if (!p) throw new Error("没有选中题目");
  const uiLang = PDF_TEXT[lang] ? lang : "zh-CN";
  const themeCss = THEMES[theme]?.css ?? "";

  const diffColor = { 0: "#9aa7b4", 1: "#fe4c61", 2: "#f39c11", 3: "#ffc116", 4: "#52c41a", 5: "#3498db", 6: "#9d3dcf", 7: "#0e1d69" }[p.difficulty ?? 0] ?? "#9aa7b4";
  const chips = [];
  if (p.difficultyName) chips.push(`<span class="chip diff" style="background:${diffColor}">${escapeHtml(p.difficultyName)}</span>`);
  for (const tg of (p.tagNames ?? []).slice(0, 8)) chips.push(`<span class="chip">${escapeHtml(tg)}</span>`);
  if (p.timeLimit) chips.push(`<span class="chip">${escapeHtml(String(p.timeLimit))} ms / ${Math.round((p.memoryLimit ?? 262144) / 1024)} MB</span>`);
  chips.push(`<span class="chip">${escapeHtml(pt(uiLang, `status.${p.status ?? "todo"}`))}</span>`);

  // 复用打印页的题面渲染（decorate 会顺便把图片指向本地 /api/image/…）
  const decorated = await decorate(p);
  const body = problemBlock(decorated, 1, { twoColumn, includeCode, includeNote, lang: uiLang }, 0);

  const time = new Date().toLocaleString(uiLang === "en" ? "en-US" : uiLang === "zh-TW" ? "zh-TW" : "zh-CN");
  const url = p.url ?? `https://www.luogu.com.cn/problem/${p.pid}`;

  return `<!DOCTYPE html>
<html lang="${uiLang}"><head><meta charset="utf-8"><title>${escapeHtml(p.pid)} ${escapeHtml(p.title ?? "")}</title>
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<style>${BASE_CSS}
${themeCss}
${CARD_CSS}</style>
</head><body>
<div class="card-head">
  <span class="card-pid">${escapeHtml(p.pid)}</span>
  <span class="card-name">${escapeHtml(p.title ?? "")}</span>
</div>
<div class="card-chips">${chips.join("")}</div>
<div class="card-body">${body}</div>
<div class="card-foot"><span>${escapeHtml(pt(uiLang, "defaultTitle"))} · ${escapeHtml(time)}</span><span class="u">${escapeHtml(url)}</span></div>
<script src="/vendor/katex/katex.min.js"></script>
<script src="/vendor/katex/auto-render.min.js"></script>
<script>
(function () {
  function render() {
    if (window.renderMathInElement) {
      try {
        renderMathInElement(document.body, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\\\[", right: "\\\\]", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\\\(", right: "\\\\)", display: false }
          ],
          throwOnError: false, strict: false,
          ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"]
        });
      } catch (e) {}
    }
    document.title = "card-ready";
  }
  if (document.readyState === "complete") render();
  else window.addEventListener("load", render);
})();
</script>
</body></html>`;
}

/* ---------------- 待打印页面的临时存放 ---------------- */
const pages = new Map();
export function putPrintPage(html) {
  const token = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pages.set(token, { html, at: Date.now() });
  // 只留最近 20 份
  if (pages.size > 20) {
    const oldest = [...pages].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) pages.delete(oldest[0]);
  }
  return token;
}
export function getPrintPage(token) {
  return pages.get(token)?.html ?? null;
}

/* ---------------- 浏览器检测 ---------------- */
export function detectBrowser() {
  const cands = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  return cands.find((p) => fs.existsSync(p)) ?? "";
}

/* ---------------- 渲染 ---------------- */
let rendering = false;

/** 通过 CDP 打印成 PDF：能带上「文档大纲」（书签），也能等页面脚本算完目录页码 */
async function cdpPrintToPdf(wsUrl, { outPath, deadline = Date.now() + 90000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("连接浏览器调试端口失败"));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (!m.id) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++seq;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    // 等页面脚本跑完（渲染完成 + 目录页码回填完成）
    for (let i = 0; i < 120; i++) {
      const ready = await ev(`(function () {
        if (document.readyState !== "complete") return false;
        if (document.title !== "rendered") return false;
        if (document.querySelector(".toc-list") && !document.documentElement.hasAttribute("data-toc-ready")) return false;
        if (document.fonts && document.fonts.status !== "loaded") return false;
        if ([].slice.call(document.images).some(function (im) { return !im.complete; })) return false;
        return true;
      })()`).catch(() => false);
      if (ready) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const r = await send("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,          // 用 @page 里的 A4 尺寸
      generateDocumentOutline: true,    // ← 关键：按 h1/h2/h3 生成 PDF 书签
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    });
    const buf = Buffer.from(r.data, "base64");
    fs.writeFileSync(outPath, buf);
    return { buffer: buf };
  } finally {
    try { ws.close(); } catch { /* 忽略 */ }
  }
}

export async function renderPdf({ url, outPath, timeoutMs = 90000 }) {
  const cfg = loadConfig();
  const bin = cfg.browser || detectBrowser();
  if (!bin || !fs.existsSync(bin)) {
    throw new Error("没找到 Edge/Chrome，无法直接生成 PDF。请在设置里指定浏览器路径。");
  }
  if (rendering) throw new Error("正在生成中，请稍候再试");
  rendering = true;
  const port = 9511 + Math.floor(Math.random() * 300);
  const profile = path.join(BUILD_DIR, "pdf-profile");
  let child = null;
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.rmSync(outPath, { force: true });
    fs.mkdirSync(profile, { recursive: true });
    child = spawn(bin, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-sync", "--hide-scrollbars",
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      "--window-size=1200,1600", url,
    ], { stdio: "ignore", windowsHide: true });

    const deadline = Date.now() + timeoutMs;
    let target = null;
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === "page");
      } catch { /* 还没起来 */ }
      if (!target) await new Promise((r) => setTimeout(r, 200));
    }
    if (!target) {
      throw new Error("浏览器没能启动（拿不到调试端口）。若在受限沙箱里运行，请用 start.bat 正常启动。");
    }

    await cdpPrintToPdf(target.webSocketDebuggerUrl, { outPath, deadline });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
      throw new Error("浏览器没能生成 PDF（文件为空）");
    }
    return { file: outPath, size: fs.statSync(outPath).size };
  } finally {
    try { child?.kill(); } catch { /* 忽略 */ }
    rendering = false;
  }
}

export function exportDir() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  return EXPORT_DIR;
}

/* ---------------- 渲染成 PNG（分享卡片） ---------------- */

/** 连上无头浏览器，等页面/字体/图片就绪后按内容尺寸截图 */
async function cdpScreenshot(wsUrl, { scale = 2, deadline = Date.now() + 60000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("连接浏览器调试端口失败"));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (!m.id) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++seq;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    // 等页面、字体、图片都就绪（KaTeX 渲染完会把 title 改成 card-ready）
    for (let i = 0; i < 80; i++) {
      const ready = await ev(`(async () => {
        if (document.readyState !== "complete") return false;
        if (document.fonts && document.fonts.status !== "loaded") return false;
        if ([...document.images].some((im) => !im.complete)) return false;
        if (document.title !== "card-ready" && !window.readyStateForShot) return false;
        return true;
      })()`).catch(() => false);
      if (ready) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const box = JSON.parse(await ev(`(() => {
      const b = document.body.getBoundingClientRect();
      const h = Math.max(document.documentElement.scrollHeight, Math.ceil(b.height));
      return JSON.stringify({ x: Math.round(b.left), y: 0, width: Math.ceil(b.width), height: h });
    })()`));
    const r = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale },
    });
    return { buffer: Buffer.from(r.data, "base64"), box };
  } finally {
    try { ws.close(); } catch { /* 忽略 */ }
  }
}

/** 把页面渲染成 PNG 文件（用系统 Edge/Chrome 的无头模式 + CDP 精确裁剪） */
export async function renderPng({ url, outPath, width = 920, height = 1400, scale = 2, timeoutMs = 60000 }) {
  const cfg = loadConfig();
  const bin = cfg.browser || detectBrowser();
  if (!bin || !fs.existsSync(bin)) {
    throw new Error("没找到 Edge/Chrome，无法生成图片。请在设置里指定浏览器路径。");
  }
  if (rendering) throw new Error("正在生成中，请稍候再试");
  rendering = true;
  const port = 9411 + Math.floor(Math.random() * 300);
  const profile = path.join(BUILD_DIR, "png-profile");
  let child = null;
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.rmSync(outPath, { force: true });
    fs.mkdirSync(profile, { recursive: true });
    child = spawn(bin, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-sync", "--hide-scrollbars",
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      `--window-size=${width},${height}`, url,
    ], { stdio: "ignore", windowsHide: true });

    const deadline = Date.now() + timeoutMs;
    let target = null;
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === "page");
      } catch { /* 还没起来 */ }
      if (!target) await new Promise((r) => setTimeout(r, 200));
    }
    if (!target) throw new Error("浏览器没起来（拿不到调试端口）");

    const { buffer } = await cdpScreenshot(target.webSocketDebuggerUrl, { scale, deadline });
    fs.writeFileSync(outPath, buffer);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 500) throw new Error("生成图片失败（文件为空）");
    return { file: outPath, size: fs.statSync(outPath).size };
  } finally {
    try { child?.kill(); } catch { /* 忽略 */ }
    rendering = false;
  }
}

export { EXPORT_DIR };
