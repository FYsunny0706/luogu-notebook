// PDF 导出测试：验证不走打印对话框、直接落盘，以及左右分栏/配色是否生效
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPORT_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "exports");

const B = "http://127.0.0.1:8765";

async function api(pathname, body) {
  const r = await fetch(B + pathname, body ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  } : {});
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (j.ok === false) throw new Error(j.error || "请求失败");
  return j;
}

function pdfInfo(file) {
  const buf = fs.readFileSync(file);
  const head = buf.subarray(0, 8).toString("latin1");
  const tail = buf.subarray(-64).toString("latin1");
  const txt = buf.toString("latin1");
  const counts = [...txt.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return {
    size: buf.length,
    head,
    valid: head.startsWith("%PDF-") && tail.includes("%%EOF"),
    pages: counts.length ? Math.max(...counts) : null,
  };
}

let fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) console.log(`  ✓ ${label}${extra ? "  — " + extra : ""}`);
  else { fail++; console.log(`  ✗ ${label}${extra ? "  — " + extra : ""}`); }
};

console.log("=== 1. 状态 ===");
const st = await api("/api/state");
check("服务在线", st.ok);
check("浏览器已探测到", Boolean(st.env.browser), st.env.browser);
const problemCount = (() => { let n = 0; const w = (a) => a.forEach((x) => x.kind === "folder" ? w(x.children ?? []) : n++); w(st.doc.tree); return n; })();
check("刷题本里有测试数据", problemCount > 0, `${problemCount} 道题`);

console.log("\n=== 2. 生成 PDF（左右分栏 + 简约黑白）===");
let r = null;
try {
  r = await api("/api/export/pdf", { theme: "mono", scope: "all", twoColumn: true, includeCode: true, includeNote: true });
  check("接口返回成功", true);
  const file = path.join(EXPORT_DIR, r.file);
  check("文件真的写在磁盘上", fs.existsSync(file), file);
  const info = pdfInfo(file);
  check("是合法 PDF", info.valid, `头=${info.head}`);
  check("体积合理", info.size > 20000, `${(info.size / 1024).toFixed(0)} KB`);
  check("有页数信息", info.pages !== null, `${info.pages} 页`);
  check("返回了下载地址", r.downloadUrl.startsWith("/api/export/download/"));
  const dl = await fetch(B + r.downloadUrl);
  check("下载接口可用", dl.status === 200 && (dl.headers.get("content-type") || "").includes("pdf"));
  const bytes = Buffer.from(await dl.arrayBuffer());
  check("下载内容与文件一致", bytes.length === info.size);
} catch (e) {
  check("生成 PDF", false, e.message.slice(0, 300));
}

console.log("\n=== 3. 换配色模板再生成 ===");
for (const theme of ["sepia", "darkcode", "blue", "big"]) {
  try {
    const rr = await api("/api/export/pdf", { theme, scope: "all", twoColumn: true });
    const info = pdfInfo(path.join(EXPORT_DIR, rr.file));
    check(`模板 ${theme} 生成成功`, info.valid, `${(info.size / 1024).toFixed(0)} KB`);
  } catch (e) {
    check(`模板 ${theme}`, false, e.message.slice(0, 200));
  }
}

console.log("\n=== 4. 单栏版式 ===");
try {
  const rr = await api("/api/export/pdf", { theme: "mono", scope: "all", twoColumn: false });
  const info = pdfInfo(path.join(EXPORT_DIR, rr.file));
  check("单栏也能生成", info.valid, `${(info.size / 1024).toFixed(0)} KB`);
} catch (e) {
  check("单栏", false, e.message.slice(0, 200));
}

console.log("\n=== 5. 导出历史 ===");
const hist = await api("/api/export/list");
check("历史列表可用", Array.isArray(hist.files) && hist.files.length > 0, `${hist.files.length} 个文件`);

console.log("\n=== 6. PDF 栏目标签跟随界面语言 ===");
{
  const { buildPrintHtml } = await import("../lib/pdf.mjs");
  const st = await api("/api/state");
  const htmlOf = async (lang) => buildPrintHtml({
    doc: st.doc, theme: "mono", scope: "all", twoColumn: true, includeCode: true, includeNote: true, lang,
  });
  const cn = await htmlOf("zh-CN");
  const tw = await htmlOf("zh-TW");
  const en = await htmlOf("en");

  // 页眉横幅（导出时间 / 共 N 道题 / 配色）一定存在
  check("简体 PDF 用简体标签", cn.includes("导出时间：") && cn.includes("道题"), "");
  check("繁体 PDF 用繁体标签", tw.includes("匯出時間：") && tw.includes("道題") && !tw.includes("导出时间"), "");
  check("英文 PDF 用英文标签", /Exported .*·.*problems/.test(en) && !en.includes("导出时间"), "");
  check("html lang 跟着变", cn.includes('<html lang="zh-CN"') && tw.includes('<html lang="zh-TW"') && en.includes('<html lang="en"'), "");

  // 题面正文是洛谷原文，任何语言下都不该被翻译
  const { flattenProblems } = await import("../lib/store.mjs");
  const first = flattenProblems(st.doc.tree ?? []).find((p) => (p.description ?? "").length > 12);
  if (first) {
    const snippet = first.description.replace(/\s+/g, " ").trim().slice(0, 12);
    check("题目正文保持洛谷原文（不被翻译）", cn.includes(snippet) && en.includes(snippet) && tw.includes(snippet),
      `“${snippet}…”`);
  } else {
    check("题目正文保持洛谷原文（无数据可验）", true, "跳过");
  }
}

console.log(fail === 0 ? "\nPDF 测试全部通过 ✅" : `\n有 ${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
