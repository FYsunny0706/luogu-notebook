// 存储层
//  · 多刷题本档案：data/profiles.json + data/notebooks/<id>.json
//  · 每个档案保存时同步导出同名 .md
//  · 题目节点可带自测数据点(tests)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(root, "data");
const NOTEBOOKS_DIR = path.join(DATA_DIR, "notebooks");
const PROFILES_PATH = path.join(DATA_DIR, "profiles.json");
const LEGACY_JSON = path.join(DATA_DIR, "notebook.json");
const LEGACY_MD = path.join(DATA_DIR, "notebook.md");

const STATUS_LABEL = { todo: "未做", ac: "✅ 已通过", review: "🔁 待复习", stuck: "⚠️ 卡住" };
const STATUS_FROM_LABEL = { "未做": "todo", "已通过": "ac", "待复习": "review", "卡住": "stuck" };

let cache = null;      // 当前档案的文档
let cacheProfile = null; // 当前档案 id

export function newId(prefix = "n") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
export function newFolder(name = "新建文件夹") {
  return { id: newId("f"), kind: "folder", name, collapsed: false, children: [] };
}
function emptyDoc(title = "我的刷题本") {
  return {
    version: 3,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tree: [],
  };
}

/* ============================ 档案 ============================ */

function readProfilesRaw() {
  try {
    const p = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8").replace(/^\uFEFF/, ""));
    if (Array.isArray(p.list) && p.list.length) return p;
  } catch { /* 还没建 */ }
  return null;
}

/** 首次运行：把老的单档案结构迁移成「默认档案」 */
function ensureProfiles() {
  fs.mkdirSync(NOTEBOOKS_DIR, { recursive: true });
  let p = readProfilesRaw();
  if (!p) {
    let name = "我的刷题本";
    if (fs.existsSync(LEGACY_JSON)) {
      try {
        const old = JSON.parse(fs.readFileSync(LEGACY_JSON, "utf8").replace(/^\uFEFF/, ""));
        name = old.title || name;
        fs.renameSync(LEGACY_JSON, path.join(NOTEBOOKS_DIR, "default.json"));
        if (fs.existsSync(LEGACY_MD)) {
          try { fs.renameSync(LEGACY_MD, path.join(NOTEBOOKS_DIR, "default.md")); } catch {}
        }
      } catch { /* 读坏了就当新档 */ }
    }
    p = { active: "default", list: [{ id: "default", name, createdAt: new Date().toISOString() }] };
    atomicWrite(PROFILES_PATH, JSON.stringify(p, null, 2));
  }
  // 保证 active 指向存在的档案
  if (!p.list.some((x) => x.id === p.active)) p.active = p.list[0].id;
  return p;
}

export function listProfiles() {
  const p = ensureProfiles();
  return { active: p.active, list: p.list };
}
export function activeProfileId() {
  return ensureProfiles().active;
}
export function notebookPath(id) {
  return path.join(NOTEBOOKS_DIR, `${id}.json`);
}
export function markdownPath(id) {
  return path.join(NOTEBOOKS_DIR, `${id}.md`);
}
export function activePaths() {
  const id = activeProfileId();
  return { json: notebookPath(id), markdown: markdownPath(id), profiles: PROFILES_PATH };
}

function writeProfiles(p) {
  atomicWrite(PROFILES_PATH, JSON.stringify(p, null, 2));
}

export function switchProfile(id) {
  const p = ensureProfiles();
  if (!p.list.some((x) => x.id === id)) throw new Error("档案不存在");
  flush(); // 先把当前档案落盘
  p.active = id;
  writeProfiles(p);
  cache = null;
  cacheProfile = null;
  return listProfiles();
}
export function createProfile(name = "新刷题本") {
  const p = ensureProfiles();
  const id = `nb_${Date.now().toString(36)}`;
  p.list.push({ id, name: String(name).trim() || "新刷题本", createdAt: new Date().toISOString() });
  p.active = id;
  writeProfiles(p);
  cache = null;
  cacheProfile = null;
  atomicWrite(notebookPath(id), JSON.stringify(emptyDoc(name), null, 2));
  return { id, profiles: listProfiles() };
}
export function renameProfile(id, name) {
  const p = ensureProfiles();
  const t = p.list.find((x) => x.id === id);
  if (!t) throw new Error("档案不存在");
  t.name = String(name).trim() || t.name;
  t.updatedAt = new Date().toISOString();
  writeProfiles(p);
  if (id === p.active && cache) cache.title = t.name;
  return listProfiles();
}
export function deleteProfile(id) {
  const p = ensureProfiles();
  if (p.list.length <= 1) throw new Error("至少要保留一个刷题本");
  p.list = p.list.filter((x) => x.id !== id);
  if (p.active === id) p.active = p.list[0].id;
  writeProfiles(p);
  try { fs.rmSync(notebookPath(id), { force: true }); } catch {}
  try { fs.rmSync(markdownPath(id), { force: true }); } catch {}
  cache = null;
  cacheProfile = null;
  return listProfiles();
}

/* ============================ 树操作 ============================ */

export function walk(nodes, fn, parent = null) {
  for (const n of nodes ?? []) {
    fn(n, parent);
    if (n.kind === "folder" && Array.isArray(n.children)) walk(n.children, fn, n);
  }
}
export function findNode(nodes, id) {
  let hit = null;
  walk(nodes, (n, parent) => { if (!hit && n.id === id) hit = { node: n, parent }; });
  return hit;
}
export function flattenProblems(tree = cache?.tree ?? []) {
  const out = [];
  walk(tree, (n) => { if (n.kind === "problem") out.push(n); });
  return out;
}

/* ============================ 读写 ============================ */

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/** v1（大/小标题的扁平 items）→ 文件夹树 */
export function migrateDoc(doc) {
  if (Array.isArray(doc.tree)) {
    delete doc.items;
    if (doc.version !== 3) doc.version = 3;
    return doc;
  }
  if (!Array.isArray(doc.items)) return { ...doc, version: 3, tree: [] };
  const tree = [];
  const stack = [];
  for (const it of doc.items) {
    if (it.kind === "heading") {
      const level = Math.min(Math.max(it.level ?? 2, 1), 2);
      while (stack.length >= level) stack.pop();
      const folder = newFolder(it.title ?? "未命名");
      folder.id = it.id ?? folder.id;
      (stack.length ? stack[stack.length - 1].children : tree).push(folder);
      stack.push(folder);
    } else {
      delete it.level;
      (stack.length ? stack[stack.length - 1].children : tree).push(it);
    }
  }
  const next = { ...doc, version: 3, tree };
  delete next.items;
  return next;
}

export function load() {
  const id = activeProfileId();
  if (cache && cacheProfile === id) return cache;
  const file = notebookPath(id);
  let doc;
  try {
    doc = migrateDoc(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
  } catch {
    const prof = ensureProfiles().list.find((x) => x.id === id);
    doc = emptyDoc(prof?.name ?? "我的刷题本");
  }
  cache = { ...emptyDoc(), ...doc };
  cacheProfile = id;
  return cache;
}

export function save(doc) {
  const id = activeProfileId();
  const next = migrateDoc({ ...load(), ...doc, updatedAt: new Date().toISOString() });
  cache = next;
  cacheProfile = id;
  atomicWrite(notebookPath(id), JSON.stringify(next, null, 2));
  atomicWrite(markdownPath(id), toMarkdown(next));
  return next;
}

/** 把当前内存里的文档立刻落盘（切换档案/退出前调用） */
export function flush() {
  if (!cache) return;
  try { save(cache); } catch {}
}

export function backup() {
  fs.mkdirSync(path.join(DATA_DIR, "backups"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const id = activeProfileId();
  const file = path.join(DATA_DIR, "backups", `${id}-${stamp}.json`);
  atomicWrite(file, JSON.stringify(load(), null, 2));
  return file;
}

/* ============================ 导出 Markdown ============================ */

export function fenceFor(text) {
  const runs = String(text).match(/`{3,}/g) ?? [];
  const longest = runs.reduce((a, r) => Math.max(a, r.length), 2);
  return "`".repeat(Math.max(3, longest + 1));
}

function pairBlocks(items, label, kindLabel) {
  const out = [];
  items.forEach((c, i) => {
    const f = fenceFor(`${c.input ?? ""}\n${c.output ?? ""}`);
    const name = c.name ? `（${c.name}）` : "";
    out.push(`**${label} ${i + 1}${name} ${kindLabel}输入**`, "", `${f}text`, c.input ?? "", f, "");
    out.push(`**${label} ${i + 1}${name} ${kindLabel}输出**`, "", `${f}text`, c.output ?? "", f, "");
  });
  return out;
}

function problemToMarkdown(p, level) {
  const out = [];
  out.push(`${"#".repeat(level)} [${p.pid} ${p.title}](${p.url ?? `https://www.luogu.com.cn/problem/${p.pid}`})`);
  out.push("");
  const meta = {
    pid: p.pid,
    difficulty: p.difficulty ?? 0,
    difficultyName: p.difficultyName ?? "",
    tags: p.tagNames ?? [],
    status: p.status ?? "todo",
    timeLimit: p.timeLimit ?? 1000,
    memoryLimit: p.memoryLimit ?? 262144,
    stub: Boolean(p.stub),
    addedAt: p.addedAt ?? null,
  };
  out.push(`<!-- luogu-notebook ${JSON.stringify(meta)} -->`);
  out.push("");
  out.push(`- **难度**：${p.difficultyName || "暂无评定"}`);
  out.push(`- **算法**：${(p.tagNames ?? []).join(" / ") || "（未标注）"}`);
  const mem = p.memoryLimit ? `${(p.memoryLimit / 1024).toFixed(0)} MB` : "—";
  out.push(`- **限制**：${p.timeLimit ?? "—"} ms / ${mem}`);
  out.push(`- **状态**：${STATUS_LABEL[p.status] ?? "未做"}`);
  out.push("");

  // 内部区块标题要比这道题深一级，导入时才能识别边界；同时不低于 4 级，section() 才认得出
  const sub = "#".repeat(Math.max(4, Math.min(level + 1, 6)));
  if (p.background) out.push(`${sub} 题目情景`, "", p.background, "");
  if (p.description) out.push(`${sub} 题目描述`, "", p.description, "");
  if (p.formatI) out.push(`${sub} 输入格式`, "", p.formatI, "");
  if (p.formatO) out.push(`${sub} 输出格式`, "", p.formatO, "");
  if (Array.isArray(p.samples) && p.samples.length) {
    out.push(`${sub} 输入输出样例`, "", ...pairBlocks(p.samples, "样例", ""));
  }
  if (p.hint) out.push(`${sub} 数据范围 / 提示`, "", p.hint, "");
  if (p.note) out.push(`${sub} 我的笔记`, "", p.note, "");
  if (Array.isArray(p.tests) && p.tests.length) {
    out.push(`${sub} 我的测试点`, "", ...pairBlocks(p.tests, "测试点", "期望"));
  }

  const code = p.code ?? "";
  const cf = fenceFor(code);
  out.push(`${sub} 我的代码`, "", `${cf}cpp`, code, cf, "");
  return out.join("\n");
}

export function toMarkdown(doc = load()) {
  const d = migrateDoc(doc);
  const out = [`# ${d.title || "我的刷题本"}`, ""];
  const n = flattenProblems(d.tree ?? []).length;
  out.push(`> 导出时间：${new Date().toLocaleString("zh-CN")}　·　共 ${n} 道题`, "");

  const emit = (nodes, depth) => {
    for (const node of nodes ?? []) {
      if (node.kind === "folder") {
        out.push(`${"#".repeat(depth + 1)} ${node.name}`, "");
        emit(node.children, depth + 1);
      } else if (node.kind === "problem") {
        out.push(problemToMarkdown(node, depth + 1), "");
      }
    }
  };
  emit(d.tree ?? [], 1);
  return out.join("\n").replace(/\n{4,}/g, "\n\n\n");
}

/* ============================ 导入 Markdown ============================ */

const CODE_RE = /^(`{3,})([A-Za-z0-9+#]*)[ \t]*$/;

/** 解析 `**<标签> N（备注） [期望]输入**` / `**... [期望]输出**` 这类成对代码块 */
function parsePairs(body, label) {
  const bucket = new Map();
  const re = new RegExp(
    `\\*\\*${label}\\s*(\\d+)(?:（([^）]*)）)?\\s*(期望输入|期望输出|输入|输出)\\*\\*\\s*\\n+\`{3,}[A-Za-z0-9]*\\n([\\s\\S]*?)\\n\`{3,}`,
    "g"
  );
  let m;
  while ((m = re.exec(body))) {
    const [, idx, note, kind, content] = m;
    const cur = bucket.get(idx) ?? { name: note ?? "", input: "", output: "" };
    // 「期望输入」也含「输入」，所以按包含判断而不是全等
    if (kind.includes("输入")) cur.input = content; else cur.output = content;
    bucket.set(idx, cur);
  }
  return [...bucket].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, v]) => v);
}

function section(body, name) {
  const re = new RegExp(`^#{4,6}[ \\t]*${name}[ \\t]*$`, "m");
  const m = re.exec(body);
  if (!m) return "";
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^#{4,6}[ \t]/m);
  const chunk = next >= 0 ? rest.slice(0, next) : rest;
  return chunk.replace(/^\n+/, "").replace(/\s+$/, "");
}
function sectionCode(body, name) {
  const sec = section(body, name).trim();
  if (!sec) return "";
  const cm = /^(`{3,})\s*[A-Za-z0-9+#]*[ \t]*\n([\s\S]*?)\n?\1[ \t]*$/.exec(sec);
  return cm ? cm[2] : sec;
}

export function importMarkdown(text, { merge = false } = {}) {
  const src = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const doc = merge ? { ...load() } : emptyDoc();
  const tree = merge ? (doc.tree ?? []) : [];

  let currentProblem = null;
  let buffer = [];
  let titleConsumed = false;
  let inFence = false;
  let fenceTok = "";
  const stack = [];

  const flush = () => {
    const body = buffer.join("\n");
    buffer = [];
    if (!body.trim() || !currentProblem) return;
    currentProblem._rawBody = (currentProblem._rawBody ?? "") + (currentProblem._rawBody ? "\n" : "") + body;
  };

  const finishProblem = () => {
    if (!currentProblem) return;
    const p = currentProblem;
    const body = p._rawBody ?? "";
    delete p._rawBody;

    p.background = section(body, "题目情景") || section(body, "题目背景");
    p.description = section(body, "题目描述");
    p.formatI = section(body, "输入格式");
    p.formatO = section(body, "输出格式");
    p.hint = section(body, "数据范围\\s*/\\s*提示") || section(body, "说明/提示") || section(body, "提示");
    p.note = section(body, "我的笔记");
    p.samples = parsePairs(body, "样例").map(({ input, output }) => ({ input, output }));
    p.tests = parsePairs(body, "测试点").map((t) => ({ id: newId("t"), name: t.name ?? "", input: t.input, output: t.output }));
    p.code = sectionCode(body, "我的代码");
    if (!p.description && !p.formatI && body.trim()) p.description = body.trim();
    p.language = "cpp";
    delete p._level;
    currentProblem = null;
  };

  const parentList = () => (stack.length ? (stack[stack.length - 1].folder.children ??= []) : tree);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    if (inFence) {
      buffer.push(line);
      if (line.trimEnd().startsWith(fenceTok)) inFence = false;
      continue;
    }
    const open = CODE_RE.exec(line);
    if (open) {
      inFence = true;
      fenceTok = open[1];
      buffer.push(line);
      continue;
    }

    const h = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const titleText = h[2].trim();

      // 比当前题目层级的标题 = 题目内部区块；否则说明这道题结束了
      if (currentProblem && level > (currentProblem._level ?? 0)) {
        buffer.push(line);
        continue;
      }
      flush();
      finishProblem();

      if (level === 1 && !titleConsumed && tree.length === 0 && stack.length === 0) {
        doc.title = titleText;
        titleConsumed = true;
        continue;
      }

      let meta = null;
      for (let k = li + 1; k < Math.min(li + 4, lines.length); k++) {
        const s = lines[k].trim();
        if (!s) continue;
        const mm = /^<!--\s*luogu-notebook\s*(\{[\s\S]*?\})\s*-->$/.exec(s);
        if (mm) { try { meta = JSON.parse(mm[1]); } catch { meta = null; } }
        break;
      }

      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();

      if (meta) {
        const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(titleText);
        let pid = meta.pid ?? "";
        let title = titleText;
        if (link) {
          const inner = link[1].trim();
          const sp = inner.indexOf(" ");
          if (sp > 0) { pid = pid || inner.slice(0, sp); title = inner.slice(sp + 1); }
          else { pid = pid || inner; title = inner; }
        }
        currentProblem = {
          id: newId("p"),
          kind: "problem",
          _level: level,
          pid,
          title,
          difficulty: meta.difficulty ?? 0,
          difficultyName: meta.difficultyName ?? "",
          tagNames: meta.tags ?? [],
          status: meta.status ?? "todo",
          language: "cpp",
          timeLimit: meta.timeLimit ?? 1000,
          memoryLimit: meta.memoryLimit ?? 262144,
          stub: Boolean(meta.stub),
          url: link?.[2] ?? `https://www.luogu.com.cn/problem/${pid}`,
          code: "", note: "", tests: [],
          addedAt: meta.addedAt ?? Date.now(),
        };
        parentList().push(currentProblem);
      } else {
        const folder = newFolder(titleText);
        parentList().push(folder);
        stack.push({ level, folder });
      }
      continue;
    }

    if (currentProblem) {
      const diff = /^-[ \t]*\*\*难度\*\*：[ \t]*(.*?)[ \t]*$/.exec(line);
      if (diff && !currentProblem.difficultyName) currentProblem.difficultyName = diff[1];
      const algo = /^-[ \t]*\*\*算法\*\*：[ \t]*(.*?)[ \t]*$/.exec(line);
      if (algo && !currentProblem.tagNames?.length) {
        currentProblem.tagNames = algo[1].split(/\s*\/\s*/).filter((x) => x && x !== "（未标注）");
      }
      const st = /^-[ \t]*\*\*状态\*\*：[ \t]*(.*?)[ \t]*$/.exec(line);
      if (st) {
        const key = st[1].replace(/[✅🔁⚠️\s]/g, "");
        currentProblem.status = STATUS_FROM_LABEL[key] ?? currentProblem.status;
      }
    }
    buffer.push(line);
  }

  flush();
  finishProblem();

  return { ...doc, version: 3, tree, updatedAt: new Date().toISOString() };
}

/* ============================ 单题分享 ============================ */

/** 打成一个自包含的题目卡片（去掉个人时间戳噪音，保留题面/代码/笔记/测试点） */
export function exportProblemCard(p) {
  return {
    format: "luogu-notebook-problem",
    version: 1,
    exportedAt: new Date().toISOString(),
    problem: {
      pid: p.pid, title: p.title, url: p.url,
      difficulty: p.difficulty ?? 0, difficultyName: p.difficultyName ?? "",
      tagNames: p.tagNames ?? [],
      timeLimit: p.timeLimit ?? 1000, memoryLimit: p.memoryLimit ?? 262144,
      description: p.description ?? "", formatI: p.formatI ?? "", formatO: p.formatO ?? "",
      hint: p.hint ?? "", background: p.background ?? "",
      samples: p.samples ?? [],
      status: p.status ?? "todo",
      code: p.code ?? "", note: p.note ?? "",
      tests: p.tests ?? [],
    },
  };
}

export function importProblemCard(json, { folderId = null } = {}) {
  const card = typeof json === "string" ? JSON.parse(json) : json;
  if (card?.format !== "luogu-notebook-problem" || !card.problem) {
    throw new Error("不是本工具导出的题目卡片");
  }
  const p = card.problem;
  const node = {
    id: newId("p"), kind: "problem",
    pid: p.pid, title: p.title, url: p.url,
    difficulty: p.difficulty ?? 0, difficultyName: p.difficultyName ?? "",
    tagNames: p.tagNames ?? [],
    timeLimit: p.timeLimit ?? 1000, memoryLimit: p.memoryLimit ?? 262144,
    description: p.description ?? "", formatI: p.formatI ?? "", formatO: p.formatO ?? "",
    hint: p.hint ?? "", background: p.background ?? "",
    samples: p.samples ?? [],
    status: p.status ?? "todo",
    code: p.code ?? "", note: p.note ?? "",
    tests: p.tests ?? [],
    language: "cpp",
    addedAt: Date.now(),
  };
  const doc = load();
  let dest = doc.tree;
  if (folderId) {
    const hit = findNode(doc.tree, folderId);
    if (hit?.node.kind === "folder") dest = (hit.node.children ??= []);
  }
  dest.unshift(node);
  save(doc);
  return node;
}

export {
  DATA_DIR, PROFILES_PATH, NOTEBOOKS_DIR,
  STATUS_LABEL, STATUS_FROM_LABEL,
};
