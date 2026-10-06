// 洛谷刷题本 · 本地服务（零依赖，只用 node 内置模块）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { fetchProblem, searchProblems, fetchUserPractice, fetchTraining, IMAGES_DIR } from "./lib/luogu.mjs";
import { judge, loadConfig, saveConfig, killAll, warmup } from "./lib/judge.mjs";
import {
  load, save, flush, toMarkdown, toMarkdownScoped, importMarkdown, backup, flattenProblems,
  listProfiles, switchProfile, createProfile, renameProfile, deleteProfile,
  activePaths, exportProblemCard, importProblemCard, findNode,
  writeLock, clearLock, anotherInstance, takeLoadNotice, takeConflict,
  listBackups, restoreBackup, scanForOldData, adoptData, resetCache, countProblems,
  listSnapshots, saveSnapshot, readSnapshot, deleteSnapshot,
} from "./lib/store.mjs";
import { formatCode, findClangFormat, downloadClangFormat, STYLE_PRESETS } from "./lib/format.mjs";
import { buildPrintHtml, buildCardHtml, putPrintPage, getPrintPage, renderPdf, renderPng, detectBrowser, exportDir, THEMES, EXPORT_DIR } from "./lib/pdf.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(root, "public");
const PREFERRED_PORT = Number(process.env.PORT ?? 8765);
let listeningPort = PREFERRED_PORT;

const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
  catch { return { name: "luogu-notebook", version: "0.0.0" }; }
})();

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".ico": "image/x-icon", ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const target = path.resolve(PUBLIC_DIR, "." + rel);
  if (!target.startsWith(PUBLIC_DIR)) { res.writeHead(403).end("forbidden"); return true; }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return false;
  const ext = path.extname(target).toLowerCase();
  const stat = fs.statSync(target);
  // 本地应用：除了体积大、基本不变的 vendor 依赖，其余一律 no-store。
  // 否则改完代码/升级完版本，刷新页面可能还是浏览器缓存里的旧 js/css（sw.js 尤其不能缓存）。
  const isVendor = rel.startsWith("/vendor/");
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": isVendor ? "public, max-age=604800" : "no-store",
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

/** 题面图片：从 data/images/<pid>/<file> 提供（抓题时下载到本地，离线也能看） */
function serveProblemImage(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath.slice("/api/image/".length)).replace(/\\/g, "/");
  if (rel.includes("..")) { res.writeHead(403); res.end("forbidden"); return; }
  const target = path.resolve(IMAGES_DIR, rel);
  if (!target.startsWith(IMAGES_DIR)) { res.writeHead(403); res.end("forbidden"); return; }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  const stat = fs.statSync(target);
  res.writeHead(200, {
    "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "public, max-age=604800",
  });
  fs.createReadStream(target).pipe(res);
}

/** 首次运行向导需要的环境体检 */
function environmentCheck() {
  const cfg = loadConfig();
  const browser = cfg.browser || detectBrowser();
  return {
    version: pkg.version,
    gpp: cfg.gpp ?? "",
    hasGpp: Boolean(cfg.gpp && fs.existsSync(cfg.gpp)),
    browser: browser || "",
    hasBrowser: Boolean(browser && fs.existsSync(browser)),
    clangFormat: findClangFormat(),
    luoguUid: cfg.luoguUid ?? "",
    repo: cfg.repo ?? "",
    style: cfg.formatStyle ?? "file",
    uiTheme: cfg.uiTheme ?? "dark",
    uiLang: cfg.uiLang ?? "zh-CN",
    platform: process.platform,
    node: process.version,
    // 向导只在第一次真正露一次：首次运行 且 用户还没点过「知道了」
    firstRun: FIRST_RUN && !cfg.wizardDone,
  };
}

/* ============================ 路由 ============================ */

const routes = {
  "GET /api/health": async () => ({ ok: true, time: new Date().toISOString(), port: listeningPort, version: pkg.version }),

  "GET /api/state": async () => {
    const paths = activePaths();
    const other = anotherInstance();
    return {
      ok: true,
      doc: load(),
      profiles: listProfiles(),
      themes: Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name })),
      styles: STYLE_PRESETS,
      env: environmentCheck(),
      paths: { json: paths.json, markdown: paths.markdown, exports: EXPORT_DIR },
      // 数据安全：一次性提示（损坏/恢复/迁移）+ 多实例情况
      safety: {
        notice: takeLoadNotice(),
        conflict: takeConflict(),
        anotherInstance: other ? { pid: other.pid, port: other.port, startedAt: other.startedAt } : null,
      },
    };
  },

  /* ---------- 档案 ---------- */
  "POST /api/profile/switch": async (body) => ({ ok: true, profiles: switchProfile(body.id) }),
  "POST /api/profile/create": async (body) => {
    const r = createProfile(body.name);
    return { ok: true, id: r.id, profiles: r.profiles };
  },
  "POST /api/profile/rename": async (body) => ({ ok: true, profiles: renameProfile(body.id, body.name) }),
  "POST /api/profile/delete": async (body) => ({ ok: true, profiles: deleteProfile(body.id) }),

  /* ---------- 题目 ---------- */
  "POST /api/problem/fetch": async (body) => {
    const keepBackground = body.keepBackground === undefined ? true : Boolean(body.keepBackground);
    return { ok: true, problem: await fetchProblem(body.pid, { keepBackground }) };
  },
  "POST /api/problem/search": async (body) => ({
    ok: true, list: await searchProblems(body.keyword ?? "", body.page ?? 1),
  }),
  "POST /api/training/fetch": async (body) => ({
    ok: true, training: await fetchTraining(body.id ?? body.url ?? ""),
  }),
  "POST /api/problem/export": async (body) => {
    const p = flattenProblems(load().tree ?? []).find((x) => x.id === body.id || x.pid === body.pid);
    if (!p) throw new Error("没有找到这道题");
    return { ok: true, card: exportProblemCard(p), file: `${p.pid}-${p.title}.json`.replace(/[\\/:*?"<>|]/g, "_") };
  },
  "POST /api/problem/import": async (body) => {
    const node = importProblemCard(body.card, { folderId: body.folderId ?? null });
    return { ok: true, node, doc: load() };
  },

  /* ---------- 同步 ---------- */
  "POST /api/sync/luogu": async (body) => {
    const data = await fetchUserPractice(body.uid);
    const local = flattenProblems(load().tree ?? []);
    const localPids = new Set(local.map((p) => p.pid));
    const passedPids = new Set(data.passed.map((p) => p.pid));
    return {
      ok: true,
      user: data.user,
      passed: data.passed,
      submitted: data.submitted,
      stats: {
        passedTotal: data.passed.length,
        submittedTotal: data.submitted.length,
        alreadyLocal: data.passed.filter((p) => localPids.has(p.pid)).length,
        notLocal: data.passed.filter((p) => !localPids.has(p.pid)).length,
        localNotPassed: local.filter((p) => !passedPids.has(p.pid) && (p.status ?? "todo") !== "ac").length,
      },
    };
  },

  /* ---------- 代码版本历史 ---------- */
  "POST /api/snapshot/list": async (body) => ({ ok: true, list: listSnapshots(body.pid ?? "") }),
  "POST /api/snapshot/save": async (body) => ({
    ok: true,
    snapshot: saveSnapshot(body.pid ?? "", body.code ?? "", { label: body.label ?? "", result: body.result ?? "" }),
  }),
  "POST /api/snapshot/get": async (body) => ({ ok: true, code: readSnapshot(body.pid ?? "", body.id ?? "") }),
  "POST /api/snapshot/delete": async (body) => ({ ok: true, list: deleteSnapshot(body.pid ?? "", body.id ?? "") }),

  /* ---------- 存档 ---------- */
  "POST /api/save": async (body) => {
    if (!body.doc) throw new Error("缺少 doc");
    const saved = save(body.doc, { force: Boolean(body.force) });
    const conflict = takeConflict();
    if (conflict) {
      return {
        ok: true, conflict: true, updatedAt: saved.updatedAt,
        message: "检测到另一个实例改过数据，本次没有覆盖；你的版本已另存到 data/backups/",
      };
    }
    return { ok: true, updatedAt: new Date().toISOString() };
  },
  "GET /api/markdown": async () => ({ ok: true, markdown: toMarkdown(load()) }),
  "POST /api/import": async (body) => {
    const doc = importMarkdown(body.markdown ?? "", { merge: Boolean(body.merge) });
    if (body.persist !== false) save(doc);
    return { ok: true, doc, count: flattenProblems(doc.tree ?? []).length };
  },
  "POST /api/backup": async () => ({ ok: true, file: backup() }),
  "POST /api/backup/list": async () => ({ ok: true, list: listBackups() }),
  "POST /api/backup/restore": async (body) => {
    const r = restoreBackup(body.name);
    return { ok: true, ...r, doc: load() };
  },
  "POST /api/adopt/scan": async () => ({ ok: true, list: scanForOldData() }),
  "POST /api/adopt/import": async (body) => {
    const r = adoptData(body.dir);
    return { ok: true, ...r, doc: load() };
  },

  /* ---------- 评测 ---------- */
  "POST /api/run": async (body) => ({
    ok: true,
    result: await judge({
      code: body.code ?? "", id: body.id ?? "scratch",
      tests: body.tests ?? [], timeLimitMs: body.timeLimitMs ?? 1000,
    }),
  }),
  "POST /api/kill": async () => { killAll(); return { ok: true }; },

  /* ---------- 格式化 ---------- */
  "POST /api/format": async (body) => {
    const r = await formatCode(body.code ?? "", body.style ?? loadConfig().formatStyle ?? "file");
    return { ok: true, code: r.code, bin: r.bin };
  },
  "POST /api/format/download": async () => {
    const r = await downloadClangFormat();
    return { ok: true, file: r.file, size: r.size };
  },

  /* ---------- 设置 ---------- */
  "POST /api/config": async (body) => {
    const patch = {};
    for (const k of ["gpp", "browser", "luoguUid", "clangFormat", "formatStyle", "repo", "wizardDone", "uiTheme", "uiLang"]) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    saveConfig(patch);
    return { ok: true, env: environmentCheck() };
  },

  /* ---------- 更新检查 ---------- */
  "POST /api/update/check": async () => {
    const repo = String(loadConfig().repo ?? "").trim();
    if (!repo) throw new Error("还没配置更新源。在「设置 → 更新源」里填上你的 GitHub 仓库（owner/name）");
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { "user-agent": `luogu-notebook/${pkg.version}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`查询失败：HTTP ${res.status}（仓库不存在或没有 Release）`);
    const j = await res.json();
    const latest = String(j.tag_name ?? "").replace(/^v/, "");
    const current = String(pkg.version).replace(/^v/, "");
    const cmp = (a, b) => {
      const A = a.split(".").map(Number), B = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
      return 0;
    };
    return {
      ok: true, current, latest, hasUpdate: cmp(latest, current) > 0,
      url: j.html_url, notes: String(j.body ?? "").slice(0, 4000), publishedAt: j.published_at,
    };
  },

  /* ---------- PDF ---------- */
  "POST /api/export/pdf": async (body) => {
    const doc = load();
    const theme = THEMES[body.theme] ? body.theme : "mono";
    const html = await buildPrintHtml({
      doc, theme,
      scope: body.scope === "current" ? "current" : "all",
      targetId: body.targetId ?? null,
      twoColumn: body.twoColumn !== false,
      includeCode: body.includeCode !== false,
      includeNote: body.includeNote !== false,
      lang: ["zh-CN", "zh-TW", "en"].includes(body.lang) ? body.lang : (loadConfig().uiLang ?? "zh-CN"),
      toc: Boolean(body.toc),
    });
    const token = putPrintPage(html);
    const url = `http://127.0.0.1:${listeningPort}/print/${token}`;
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    const safeTitle = String(doc.title || "刷题本").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
    const fileName = `${safeTitle}-${stamp}.pdf`;
    const outPath = path.join(exportDir(), fileName);
    const r = await renderPdf({ url, outPath });
    return { ok: true, file: fileName, size: r.size, downloadUrl: `/api/export/download/${encodeURIComponent(fileName)}`, dir: EXPORT_DIR };
  },

  /* ---------- 导出：Markdown（可多题合并）/ PNG 分享卡片 ---------- */
  "POST /api/export/markdown": async (body) => {
    const doc = load();
    const scope = body.scope === "current" ? "current" : "all";
    const targetId = body.targetId ?? null;
    const md = toMarkdownScoped(doc, { scope, targetId, toc: body.toc !== false });
    let base = String(doc.title || "刷题本");
    if (scope === "current" && targetId) {
      const hit = findNode(doc.tree ?? [], targetId)?.node;
      if (hit?.kind === "problem") base = `${hit.pid} ${hit.title ?? ""}`.trim();
      else if (hit?.kind === "folder") base = hit.name;
    }
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    const safe = base.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "刷题本";
    const fileName = `${safe}-${stamp}.md`;
    const outPath = path.join(exportDir(), fileName);
    fs.writeFileSync(outPath, md, "utf8");
    return {
      ok: true, file: fileName, size: fs.statSync(outPath).size,
      downloadUrl: `/api/export/download/${encodeURIComponent(fileName)}`,
      chars: md.length, count: flattenProblems(
        scope === "current" && targetId ? [findNode(doc.tree ?? [], targetId)?.node].filter(Boolean) : (doc.tree ?? [])
      ).length,
    };
  },

  "POST /api/export/card": async (body) => {
    const doc = load();
    const hit = body.targetId ? findNode(doc.tree ?? [], body.targetId)?.node : flattenProblems(doc.tree ?? [])[0];
    if (hit?.kind !== "problem") throw new Error("请先选中一道题，再生成分享卡片");
    const theme = THEMES[body.theme] ? body.theme : "darkcode";
    const html = await buildCardHtml({
      problem: hit, theme,
      lang: ["zh-CN", "zh-TW", "en"].includes(body.lang) ? body.lang : (loadConfig().uiLang ?? "zh-CN"),
    });
    const token = putPrintPage(html);
    const url = `http://127.0.0.1:${listeningPort}/print/${token}`;
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    const safe = `${hit.pid} ${hit.title ?? ""}`.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || hit.pid;
    const fileName = `${safe}-${stamp}.png`;
    const outPath = path.join(exportDir(), fileName);
    const r = await renderPng({ url, outPath });
    return { ok: true, file: fileName, size: r.size, downloadUrl: `/api/export/download/${encodeURIComponent(fileName)}`, dir: EXPORT_DIR };
  },

  "GET /api/export/list": async () => {
    const dir = exportDir();
    const files = fs.readdirSync(dir)
      .filter((f) => /\.(pdf|md|png)$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return {
          name: f, size: st.size, at: st.mtimeMs, ext: path.extname(f).toLowerCase().slice(1),
          downloadUrl: `/api/export/download/${encodeURIComponent(f)}`,
        };
      })
      .sort((a, b) => b.at - a.at).slice(0, 20);
    return { ok: true, files, dir };
  },
};

function serveDownload(res, name) {
  const dir = exportDir();
  const safe = path.basename(decodeURIComponent(name));
  const target = path.join(dir, safe);
  if (!target.startsWith(dir) || !fs.existsSync(target)) { sendJson(res, 404, { ok: false, error: "文件不存在" }); return; }
  const stat = fs.statSync(target);
  res.writeHead(200, {
    "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "content-disposition": `attachment; filename="${encodeURIComponent(safe)}"`, "cache-control": "no-store",
  });
  fs.createReadStream(target).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const key = `${req.method} ${url.pathname}`;

  if (req.method === "GET" && url.pathname.startsWith("/print/")) {
    const html = getPrintPage(url.pathname.slice("/print/".length));
    if (!html) { res.writeHead(404).end("print page expired"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/export/download/")) {
    serveDownload(res, url.pathname.slice("/api/export/download/".length));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/export/markdown") {
    const md = toMarkdown(load());
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="luogu-notebook.md"`,
    });
    res.end(md);
    return;
  }

  const handler = routes[key];
  if (handler) {
    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      sendJson(res, 200, await handler(body));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.message ?? String(e) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/image/")) { serveProblemImage(req, res, url.pathname); return; }
  if (req.method === "GET" && serveStatic(req, res, url.pathname)) return;
  sendJson(res, 404, { ok: false, error: "not found" });
}

function listen(port, attempt = 0) {
  const server = http.createServer(handle);
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && attempt < 20) listen(port + 1, attempt + 1);
    else { console.error("服务启动失败:", e.message); process.exit(1); }
  });
  server.listen(port, "127.0.0.1", () => {
    listeningPort = port;
    writeLock(port);
    const env = environmentCheck();
    const url = `http://127.0.0.1:${port}/`;
    console.log("");
    console.log("  ┌──────────────────────────────────────────────┐");
    console.log(`  │      洛谷刷题本  v${pkg.version.padEnd(28)}│`);
    console.log("  └──────────────────────────────────────────────┘");
    console.log(`  界面地址:  ${url}`);
    console.log(`  C++ 编译器: ${env.hasGpp ? env.gpp : "❌ 未找到（界面里可设置）"}`);
    console.log(`  PDF 引擎:   ${env.hasBrowser ? env.browser : "❌ 未找到 Edge/Chrome"}`);
    console.log(`  代码格式化: ${env.clangFormat || "未安装（可选）"}`);
    console.log(`  数据目录:   ${path.join(root, "data")}`);
    console.log(`  PDF 输出:   ${EXPORT_DIR}`);
    const other = anotherInstance();
    if (other) {
      console.log("");
      console.log("  ⚠️  检测到另一个刷题本实例正在运行（可能是没关掉的旧窗口）：");
      console.log(`      进程 ${other.pid}，端口 ${other.port}，启动于 ${other.startedAt}`);
      console.log("      两个实例同时改同一份数据会互相覆盖。建议关掉多余的那个。");
      console.log("      本实例在检测到数据被对方改过时会拒绝覆盖，并把你的版本另存到 data/backups/。");
    }
    console.log("  关闭此窗口即停止服务。");
    console.log("");
    warmup();
    if (process.argv.includes("--open")) {
      try {
        spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
      } catch {}
    }
  });
  return server;
}

for (const d of ["data", "build", "exports", path.join("tools", "bin")]) {
  fs.mkdirSync(path.join(root, d), { recursive: true });
}
// 注意：要在创建 config.json 之前判定是不是首次运行，否则永远是 false
const FIRST_RUN = !fs.existsSync(path.join(root, "config.json"));
if (FIRST_RUN) saveConfig({});

const shutdown = () => {
  try { flush(); } catch {}
  try { killAll(); } catch {}
  try { clearLock(); } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

listen(PREFERRED_PORT);
