// 导出整合自测：单题/多题 Markdown、单题 PNG 卡片、导出历史、范围选择
// 用法：先启动服务（默认 8765），再 node tools/test-exports.mjs
//      APP_URL=http://127.0.0.1:8790/ node tools/test-exports.mjs
// 注意：会在 exports/ 下真的生成几个文件（不影响 data/）
import fs from "node:fs";
import path from "node:path";

const APP = (process.env.APP_URL ?? "http://127.0.0.1:8765/").replace(/\/$/, "");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

const results = [];
const ok = (name, cond, extra = "") => { results.push(Boolean(cond)); console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`); };
const post = async (p, body = {}) =>
  (await fetch(APP + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

const state = await (await fetch(APP + "/api/state")).json();
const probs = [];
(function walk(t) { for (const n of t ?? []) { if (n.kind === "problem") probs.push(n); else walk(n.children); } })(state.doc.tree);
if (!probs.length) { console.error("笔记本里没有题目，先加一道再测"); process.exit(1); }
const withCode = probs.find((p) => p.code) ?? probs[0];
const folder = (function find(t) { for (const n of t ?? []) { if (n.kind === "folder") return n; const r = find(n.children); if (r) return r; } return null; })(state.doc.tree);

console.log("===== 1. 单题 Markdown =====");
{
  const r = await post("/api/export/markdown", { scope: "current", targetId: withCode.id });
  ok("生成成功", r.ok && /\.md$/.test(r.file), r.file);
  ok("只含这一道题", r.count === 1, `${r.count} 道`);
  const text = fs.readFileSync(path.join(ROOT, "exports", r.file), "utf8");
  ok("标题是这道题", text.split("\n")[0].includes(withCode.pid), text.split("\n")[0].slice(0, 40));
  ok("单题不生成目录", !text.includes("## 目录"));
  ok("含题号链接", text.includes(withCode.pid));
}

console.log("\n===== 2. 多题合并 Markdown（带目录）=====");
{
  const r = await post("/api/export/markdown", { scope: "all", toc: true });
  ok("生成成功", r.ok && /\.md$/.test(r.file), r.file);
  ok("题目数与笔记本一致", r.count === probs.length, `${r.count} / ${probs.length}`);
  const text = fs.readFileSync(path.join(ROOT, "exports", r.file), "utf8");
  ok("有目录", text.includes("## 目录"));
  ok("目录条目是锚点链接", /\n\d+\. \[P\d+[^\]]*\]\(#[\w\u4e00-\u9fff-]+\)/.test(text),
    (text.match(/\n\d+\. \[[^\]]+\]\(#[^)]+\)/) ?? [""])[0].trim().slice(0, 50));
}

console.log("\n===== 3. 不带目录 =====");
{
  const r = await post("/api/export/markdown", { scope: "all", toc: false });
  const text = fs.readFileSync(path.join(ROOT, "exports", r.file), "utf8");
  ok("确实没有目录", !text.includes("## 目录"));
}

console.log("\n===== 4. 文件夹范围 =====");
if (folder) {
  const r = await post("/api/export/markdown", { scope: "current", targetId: folder.id });
  const text = fs.readFileSync(path.join(ROOT, "exports", r.file), "utf8");
  ok("以文件夹名作标题", text.split("\n")[0].includes(folder.name), text.split("\n")[0].slice(0, 40));
  ok("只含该文件夹里的题", r.count > 0 && r.count <= probs.length, `${r.count} 道`);
} else {
  console.log("    （笔记本里没有文件夹，跳过）");
}

console.log("\n===== 5. 单题 PNG 分享卡片 =====");
{
  const r = await post("/api/export/card", { targetId: withCode.id, theme: "darkcode" });
  ok("生成成功", r.ok && /\.png$/.test(r.file), r.file);
  ok("文件不是空的", (r.size ?? 0) > 5000, `${Math.round((r.size ?? 0) / 1024)} KB`);
  const head = fs.readFileSync(path.join(ROOT, "exports", r.file)).subarray(0, 8);
  ok("确实是 PNG", head[0] === 0x89 && head[1] === 0x50, head.toString("hex"));
}

console.log("\n===== 6. 错误处理 =====");
{
  const r = await post("/api/export/card", { targetId: "not-a-real-id" });
  ok("没选中题目时友好报错", r.ok === false && /选中/.test(r.error ?? ""), r.error);
  const r2 = await post("/api/export/card", { targetId: folder?.id ?? "" });
  ok("对文件夹报错（PNG 只支持单题）", r2.ok === false, r2.error);
}

console.log("\n===== 7. 导出历史 =====");
{
  const list = await (await fetch(APP + "/api/export/list")).json();
  const exts = new Set((list.files ?? []).map((f) => f.ext));
  ok("历史里有 pdf", exts.has("pdf"));
  ok("历史里有 md", exts.has("md"));
  ok("历史里有 png", exts.has("png"));
  ok("按时间倒序", (() => {
    const a = list.files ?? [];
    for (let i = 1; i < a.length; i++) if (a[i - 1].at < a[i].at) return false;
    return true;
  })());
  const first = list.files[0];
  const dl = first.downloadUrl ?? `/api/export/download/${encodeURIComponent(first.name)}`;
  const r = await fetch(APP + dl);
  ok("下载链接能取到文件", r.ok, `HTTP ${r.status}  ${r.headers.get("content-type")}`);
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "✅" : "❌"} 导出整合自测 ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
