// 存储层
//  · 多刷题本档案：data/profiles.json + data/notebooks/<id>.json
//  · 每个档案保存时同步导出同名 .md
//  · 题目节点可带自测数据点(tests)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(root, "data");
const NOTEBOOKS_DIR = path.join(DATA_DIR, "notebooks");
const PROFILES_PATH = path.join(DATA_DIR, "profiles.json");
const LEGACY_JSON = path.join(DATA_DIR, "notebook.json");
const LEGACY_MD = path.join(DATA_DIR, "notebook.md");
const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const IMAGES_GUARD = path.join(DATA_DIR, "images");   // 题面图片（与 lib/luogu.mjs 约定一致）
const LOCK_PATH = path.join(DATA_DIR, ".lock");

/** 当前数据结构版本；以后改结构时 +1 并补 migrateDoc 分支 */
export const CURRENT_VERSION = 3;
/** 时间点快照保留份数 / 两次快照的最小间隔 */
const KEEP_SNAPSHOTS = 10;
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
/** 完整备份保留份数 */
const KEEP_BACKUPS = 10;

const STATUS_LABEL = { todo: "未做", ac: "✅ 已通过", review: "🔁 待复习", stuck: "⚠️ 卡住" };
const STATUS_FROM_LABEL = { "未做": "todo", "已通过": "ac", "待复习": "review", "卡住": "stuck" };

let cache = null;      // 当前档案的文档
let cacheProfile = null; // 当前档案 id
let cacheStamp = null;   // 载入时磁盘上的 updatedAt，用来发现「别的实例写过」
let loadNotice = null;   // 载入异常（损坏/从 .md 恢复/迁移），交给界面提示
let pendingConflict = null; // 保存时发现冲突，未落盘

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

export function countProblems(nodes) {
  return (nodes ?? []).reduce((a, n) => a + (n.kind === "problem" ? 1 : countProblems(n.children)), 0);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

/** 文件名唯一化：同一秒内多次备份不能互相覆盖（否则「恢复前先备份」会盖掉恢复源） */
function uniqueStem(prefix) {
  return `${prefix}-${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
}

/* ============================ 数据安全 ============================ */

/** 取走一次性的载入提示（损坏/恢复/迁移），给界面用 */
export function takeLoadNotice() { const n = loadNotice; loadNotice = null; return n; }
export function peekLoadNotice() { return loadNotice; }
/** 取走一次性的保存冲突提示 */
export function takeConflict() { const c = pendingConflict; pendingConflict = null; return c; }
export function peekConflict() { return pendingConflict; }

function note(kind, detail = {}) {
  loadNotice = { kind, at: new Date().toISOString(), ...detail };
}

/** 迁移前把原始数据留一份，将来迁移出问题可以回退 */
function snapshotBeforeMigrate(id, fromVersion, raw) {
  try {
    const file = path.join(BACKUPS_DIR, `pre-migrate-${id}-v${fromVersion}-${stamp()}.json`);
    atomicWrite(file, JSON.stringify(raw, null, 2));
    return file;
  } catch { return null; }
}

/** 立刻存一份带标签的快照 */
function snapshotNow(doc, tag = "auto") {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const file = path.join(BACKUPS_DIR, `${uniqueStem(tag)}.json`);
    atomicWrite(file, JSON.stringify(doc, null, 2));
    return file;
  } catch { return null; }
}

/** 每隔一段时间留一个时间点快照，并只保留最近 KEEP_SNAPSHOTS 份 */
function maybeTimedSnapshot(doc) {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const list = () => fs.readdirSync(BACKUPS_DIR).filter((f) => /^(auto|shrink)-.*\.json$/.test(f)).sort();
    const all = list();
    const newest = all[all.length - 1];
    if (newest) {
      const age = Date.now() - fs.statSync(path.join(BACKUPS_DIR, newest)).mtimeMs;
      if (age < SNAPSHOT_INTERVAL_MS) return null;
    }
    const file = snapshotNow(doc, "auto");
    const after = list();
    for (const old of after.slice(0, Math.max(0, after.length - KEEP_SNAPSHOTS))) {
      try { fs.rmSync(path.join(BACKUPS_DIR, old), { force: true }); } catch {}
    }
    return file;
  } catch { return null; }
}

/** 保存前把上一版留成 .bak（再往前滚一格），防止一次坏写就没了 */
function rotateBak(file) {
  try {
    if (!fs.existsSync(file)) return;
    const bak = `${file}.bak`;
    if (fs.existsSync(bak)) fs.copyFileSync(bak, `${bak}.1`);
    fs.copyFileSync(file, bak);
  } catch { /* 备份失败不影响保存 */ }
}

/* ---------- 单实例锁 ---------- */

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

export function writeLock(port) {
  try {
    atomicWrite(LOCK_PATH, JSON.stringify({
      pid: process.pid, port, root, startedAt: new Date().toISOString(),
    }, null, 2));
  } catch { /* 锁写不了不影响使用 */ }
}

export function clearLock() {
  try {
    const l = readLock();
    if (l?.pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
  } catch { /* 忽略 */ }
}

export function readLock() {
  try { return readJson(LOCK_PATH); } catch { return null; }
}

/** 有没有另一个还活着的实例在用同一个 data/ */
export function anotherInstance() {
  const l = readLock();
  if (!l?.pid || l.pid === process.pid) return null;
  return pidAlive(l.pid) ? l : null;
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
  const mdFile = markdownPath(id);
  let doc = null;

  if (!fs.existsSync(file)) {
    // 首次运行：正常情况，不算异常
    const prof = ensureProfiles().list.find((x) => x.id === id);
    doc = emptyDoc(prof?.name ?? "我的刷题本");
    cacheStamp = null;
  } else {
    try {
      const raw = readJson(file);
      const from = Number(raw.version ?? 0);
      if (from && from < CURRENT_VERSION) {
        const snap = snapshotBeforeMigrate(id, from, raw);
        note("migrated", { from, to: CURRENT_VERSION, snapshot: snap });
      }
      doc = migrateDoc(raw);
      cacheStamp = doc.updatedAt ?? null;
    } catch (e) {
      // 文件损坏：先把原件改名隔离（这样后续保存绝不会覆盖它），再尝试用同名 .md 重建
      let broken = null;
      try { broken = `${file}.broken-${stamp()}`; fs.renameSync(file, broken); } catch { broken = null; }
      let rebuilt = null;
      try {
        if (fs.existsSync(mdFile)) {
          const d = importMarkdown(fs.readFileSync(mdFile, "utf8"), { merge: false });
          if (countProblems(d.tree) > 0) rebuilt = d;
        }
      } catch { /* .md 也坏了就只能空文档起步 */ }

      cacheStamp = null;   // 没有可比对的基准，下一次保存直接写
      if (rebuilt) {
        doc = rebuilt;
        note("recovered", {
          brokenFile: broken, from: mdFile,
          problems: countProblems(doc.tree), error: e.message,
        });
      } else {
        const prof = ensureProfiles().list.find((x) => x.id === id);
        doc = emptyDoc(prof?.name ?? "我的刷题本");
        note("lost", { brokenFile: broken, error: e.message });
      }
    }
  }

  cache = { ...emptyDoc(), ...doc };
  cacheProfile = id;
  return cache;
}

export function save(doc, { force = false } = {}) {
  const id = activeProfileId();
  const file = notebookPath(id);
  const prev = load();
  const next = migrateDoc({ ...prev, ...doc, updatedAt: new Date().toISOString() });

  // 1) 冲突检测：磁盘上的 updatedAt 已经不是我们载入时那个 → 别的实例写过，不覆盖
  if (!force && cacheStamp) {
    let diskStamp = null;
    try { diskStamp = readJson(file).updatedAt ?? null; } catch { /* 读不到就当没冲突 */ }
    if (diskStamp && diskStamp !== cacheStamp) {
      let kept = null;
      try {
        fs.mkdirSync(BACKUPS_DIR, { recursive: true });
        kept = path.join(BACKUPS_DIR, `conflict-${id}-${stamp()}.json`);
        atomicWrite(kept, JSON.stringify(next, null, 2));
      } catch { kept = null; }
      pendingConflict = { diskStamp, mineStamp: cacheStamp, savedTo: kept };
      return next;
    }
  }

  // 2) 异常缩水：题目数骤降（不是手工删的话很可能是 bug）——存的是缩水【前】那一版
  const before = countProblems(prev.tree);
  const after = countProblems(next.tree);
  if (before >= 5 && after < before * 0.7) {
    snapshotNow(prev, `shrink-${before}to${after}`);
  }

  // 3) 正常落盘：先滚动备份，再原子替换
  rotateBak(file);
  maybeTimedSnapshot(next);
  cache = next;
  cacheProfile = id;
  atomicWrite(file, JSON.stringify(next, null, 2));
  atomicWrite(markdownPath(id), toMarkdown(next));
  cacheStamp = next.updatedAt;
  return next;
}

/** 把当前内存里的文档立刻落盘（切换档案/退出前调用） */
export function flush() {
  if (!cache) return;
  try { save(cache); } catch {}
}

/* ============================ 备份与恢复 ============================ */

export function backupsDir() { return BACKUPS_DIR; }

/** 完整备份：所有档案（json + md）+ 题面图片 + 清单 */
export function backup() {
  const dir = path.join(BACKUPS_DIR, uniqueStem("backup"));
  fs.mkdirSync(path.join(dir, "notebooks"), { recursive: true });
  const profiles = listProfiles();
  let problems = 0, images = 0, bytes = 0;

  const take = (src, dst) => {
    try {
      if (!fs.existsSync(src)) return false;
      fs.copyFileSync(src, dst);
      bytes += fs.statSync(dst).size;
      return true;
    } catch { return false; }
  };

  take(PROFILES_PATH, path.join(dir, "profiles.json"));
  for (const p of profiles.list ?? []) {
    take(notebookPath(p.id), path.join(dir, "notebooks", `${p.id}.json`));
    take(markdownPath(p.id), path.join(dir, "notebooks", `${p.id}.md`));
    try { problems += countProblems(readJson(notebookPath(p.id)).tree); } catch { /* 跳过坏档案 */ }
  }
  try {
    if (fs.existsSync(IMAGES_GUARD)) {
      fs.cpSync(IMAGES_GUARD, path.join(dir, "images"), { recursive: true });
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, e.name);
          if (e.isDirectory()) walk(fp);
          else { images++; bytes += fs.statSync(fp).size; }
        }
      };
      walk(path.join(dir, "images"));
    }
  } catch { /* 图片拷不动就只备份文本部分 */ }

  // 代码版本历史（也是用户数据，一并备份）
  let snapshots = 0;
  try {
    if (fs.existsSync(SNAPSHOTS_DIR)) {
      fs.cpSync(SNAPSHOTS_DIR, path.join(dir, "snapshots"), { recursive: true });
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, e.name);
          if (e.isDirectory()) walk(fp);
          else if (e.name.endsWith(".cpp")) { snapshots++; bytes += fs.statSync(fp).size; }
        }
      };
      walk(path.join(dir, "snapshots"));
    }
  } catch { /* 快照拷不动不影响其余备份 */ }

  atomicWrite(path.join(dir, "manifest.json"), JSON.stringify({
    at: new Date().toISOString(), version: CURRENT_VERSION,
    profiles: (profiles.list ?? []).map((p) => p.name), problems, images, snapshots, bytes,
  }, null, 2));

  pruneBackups();
  return dir;
}

function pruneBackups() {
  try {
    const dirs = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("backup-"))
      .map((e) => e.name).sort();
    for (const old of dirs.slice(0, Math.max(0, dirs.length - KEEP_BACKUPS))) {
      fs.rmSync(path.join(BACKUPS_DIR, old), { recursive: true, force: true });
    }
  } catch { /* 清理失败无所谓 */ }
}

/** 列出可恢复的备份（新的在前）：完整备份目录 + 旧的单文件备份 + 自动快照 */
export function listBackups() {
  const out = [];
  try {
    for (const e of fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })) {
      const full = path.join(BACKUPS_DIR, e.name);
      const st = fs.statSync(full);
      if (e.isDirectory() && e.name.startsWith("backup-")) {
        let manifest = {};
        try { manifest = readJson(path.join(full, "manifest.json")); } catch {}
        out.push({
          name: e.name, kind: "full", at: manifest.at ?? st.mtime.toISOString(),
          problems: manifest.problems ?? 0, images: manifest.images ?? 0,
          bytes: manifest.bytes ?? 0, profiles: manifest.profiles ?? [],
        });
      } else if (e.isFile() && /^(auto|shrink|conflict|pre-migrate)-.*\.json$/.test(e.name)) {
        let problems = 0;
        try { problems = countProblems(readJson(full).tree); } catch {}
        out.push({
          name: e.name, kind: e.name.split("-")[0], at: st.mtime.toISOString(),
          problems, images: 0, bytes: st.size, profiles: [],
        });
      } else if (e.isFile() && e.name.endsWith(".json") && !e.name.startsWith(".")) {
        // 0.x / 1.0 时代的单文件备份：<档案id>-<时间>.json
        let problems = 0;
        try { problems = countProblems(readJson(full).tree); } catch {}
        out.push({
          name: e.name, kind: "legacy", at: st.mtime.toISOString(),
          problems, images: 0, bytes: st.size, profiles: [],
        });
      }
    }
  } catch { /* 没有备份目录 */ }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 从备份恢复：先给当前状态做一次完整备份，再覆盖回去 */
export function restoreBackup(name) {
  const base = path.basename(String(name ?? ""));
  const src = path.join(BACKUPS_DIR, base);
  if (!base || !fs.existsSync(src)) throw new Error("备份不存在");
  const st = fs.statSync(src);

  const safety = backup();   // 万一恢复错了还能退回来
  let restored = { notebooks: 0, images: 0, profiles: false };

  if (st.isDirectory()) {
    fs.mkdirSync(NOTEBOOKS_DIR, { recursive: true });
    const nbDir = path.join(src, "notebooks");
    if (fs.existsSync(nbDir)) {
      for (const f of fs.readdirSync(nbDir)) {
        fs.copyFileSync(path.join(nbDir, f), path.join(NOTEBOOKS_DIR, f));
        if (f.endsWith(".json")) restored.notebooks++;
      }
    }
    const prof = path.join(src, "profiles.json");
    if (fs.existsSync(prof)) { fs.copyFileSync(prof, PROFILES_PATH); restored.profiles = true; }
    const imgDir = path.join(src, "images");
    if (fs.existsSync(imgDir)) {
      fs.cpSync(imgDir, IMAGES_GUARD, { recursive: true });
      restored.images = fs.readdirSync(imgDir).length;
    }
    const snapDirSrc = path.join(src, "snapshots");
    if (fs.existsSync(snapDirSrc)) {
      fs.cpSync(snapDirSrc, SNAPSHOTS_DIR, { recursive: true });
      try { restored.snapshots = fs.readdirSync(snapDirSrc).length; } catch { /* 忽略 */ }
    }
  } else {
    // 单文件备份：恢复成当前档案
    const id = activeProfileId();
    fs.mkdirSync(NOTEBOOKS_DIR, { recursive: true });
    fs.copyFileSync(src, notebookPath(id));
    restored.notebooks = 1;
  }

  resetCache();
  return { safety, restored, profiles: listProfiles() };
}

/** 丢掉内存缓存，强制下次 load() 重新读盘 */
export function resetCache() {
  cache = null;
  cacheProfile = null;
  cacheStamp = null;
}

/* ============================ 从旧目录导入（升级/换机器） ============================ */

const SCAN_SKIP = new Set([
  "node_modules", "build", "dist", "exports", "data", ".git", ".vs", ".vscode", "vendor",
  "AppData", "Windows", "Program Files", "Program Files (x86)", "$RECYCLE.BIN", "System Volume Information",
]);

/**
 * 在常见位置找「别的刷题本目录」（含 data/notebooks/*.json）。
 * 刻意浅扫（默认 3 层）并跳过系统目录，避免卡住。
 */
export function scanForOldData({ maxDepth = 3, roots } = {}) {
  const home = os.homedir();
  const searchRoots = roots ?? [
    path.join(home, "Desktop"), path.join(home, "OneDrive", "Desktop"),
    path.join(home, "Documents"), path.join(home, "Downloads"),
    path.dirname(root), path.resolve(root, "..", ".."),
  ];
  const found = new Map();

  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    const nbDir = path.join(dir, "data", "notebooks");
    if (fs.existsSync(nbDir)) {
      try {
        const files = fs.readdirSync(nbDir).filter((f) => f.endsWith(".json"));
        let problems = 0;
        for (const f of files) {
          try { problems += countProblems(readJson(path.join(nbDir, f)).tree); } catch {}
        }
        const isSelf = path.resolve(dir) === path.resolve(root);
        let mtime = 0;
        for (const f of files) {
          try { mtime = Math.max(mtime, fs.statSync(path.join(nbDir, f)).mtimeMs); } catch {}
        }
        if (!isSelf && files.length) {
          found.set(path.resolve(dir), {
            dir: path.resolve(dir), notebooks: files.map((f) => f.replace(/\.json$/, "")),
            problems, at: new Date(mtime || Date.now()).toISOString(),
          });
        }
      } catch { /* 读不了就跳过 */ }
      return;   // 命中就不再往里钻
    }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SCAN_SKIP.has(e.name)) continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };

  for (const r of searchRoots) {
    try { if (fs.existsSync(r)) visit(r, 1); } catch { /* 没权限就算了 */ }
  }
  return [...found.values()].sort((a, b) => b.problems - a.problems);
}

/** 把某个旧目录的 data/ 合并进来（同名覆盖，其余保留）；导入前先给现状做完整备份 */
export function adoptData(srcDir) {
  const src = path.resolve(String(srcDir ?? ""));
  const srcNotebooks = path.join(src, "data", "notebooks");
  if (!fs.existsSync(srcNotebooks)) throw new Error("这个目录里没有 data/notebooks，不像是刷题本目录");
  if (src === path.resolve(root)) throw new Error("这就是当前目录，不需要导入");

  const safety = backup();
  fs.mkdirSync(NOTEBOOKS_DIR, { recursive: true });
  const copied = { notebooks: 0, markdown: 0, images: 0, profiles: false };

  for (const f of fs.readdirSync(srcNotebooks)) {
    const s = path.join(srcNotebooks, f);
    if (!fs.statSync(s).isFile()) continue;
    fs.copyFileSync(s, path.join(NOTEBOOKS_DIR, f));
    if (f.endsWith(".json")) copied.notebooks++;
    else if (f.endsWith(".md")) copied.markdown++;
  }

  const srcProfiles = path.join(src, "data", "profiles.json");
  if (fs.existsSync(srcProfiles)) {
    // 档案列表合并：保留双方的档案，导入方优先
    try {
      const mine = readProfilesRaw() ?? { list: [], active: null };
      const theirs = readJson(srcProfiles);
      const merged = { list: [...(theirs.list ?? [])], active: theirs.active ?? null };
      const seen = new Set(merged.list.map((x) => x.id));
      for (const p of mine.list ?? []) if (!seen.has(p.id)) merged.list.push(p);
      if (!merged.active) merged.active = mine.active ?? merged.list[0]?.id ?? null;
      atomicWrite(PROFILES_PATH, JSON.stringify(merged, null, 2));
      copied.profiles = true;
    } catch { /* 合并失败就用对方的原样覆盖 */ 
      try { fs.copyFileSync(srcProfiles, PROFILES_PATH); copied.profiles = true; } catch {}
    }
  }

  const srcImages = path.join(src, "data", "images");
  if (fs.existsSync(srcImages)) {
    fs.mkdirSync(IMAGES_GUARD, { recursive: true });
    fs.cpSync(srcImages, IMAGES_GUARD, { recursive: true });
    try { copied.images = fs.readdirSync(srcImages).length; } catch { /* 忽略 */ }
  }

  const srcSnaps = path.join(src, "data", "snapshots");
  if (fs.existsSync(srcSnaps)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    fs.cpSync(srcSnaps, SNAPSHOTS_DIR, { recursive: true });
    try { copied.snapshots = fs.readdirSync(srcSnaps).length; } catch { /* 忽略 */ }
  }

  resetCache();
  return { safety, copied, profiles: listProfiles() };
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

/* ============================ 代码版本历史 ============================ */

const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");
/** 每道题最多保留多少版代码 */
const KEEP_VERSIONS = 30;

function snapPid(pid) {
  return String(pid ?? "").replace(/[^\w-]+/g, "_").slice(0, 32) || "unknown";
}
function snapDir(pid) {
  return path.join(SNAPSHOTS_DIR, snapPid(pid));
}
function snapIndex(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

/** 列出某道题的历史版本（新的在前）。索引丢了也能从 .cpp 文件名重建。 */
export function listSnapshots(pid) {
  const dir = snapDir(pid);
  if (!fs.existsSync(dir)) return [];
  const meta = new Map(snapIndex(dir).map((e) => [e.file, e]));
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".cpp")) continue;
    const st = fs.statSync(path.join(dir, f));
    const m = meta.get(f) ?? {};
    out.push({
      id: f.replace(/\.cpp$/, ""),
      file: f,
      at: m.at ?? new Date(st.mtimeMs).toISOString(),
      label: m.label ?? "",
      result: m.result ?? "",
      bytes: st.size,
      lines: m.lines ?? 0,
    });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 存一版。和最近一版内容完全相同就不重复存（评测通过时自动存会用到）。 */
export function saveSnapshot(pid, code, { label = "", result = "" } = {}) {
  const text = String(code ?? "");
  if (!text.trim()) throw new Error("代码是空的，没什么可存的");
  const dir = snapDir(pid);
  fs.mkdirSync(dir, { recursive: true });

  const before = listSnapshots(pid);
  if (before.length) {
    try {
      if (fs.readFileSync(path.join(dir, before[0].file), "utf8") === text) {
        return { ...before[0], deduped: true };
      }
    } catch { /* 读不了就照常存 */ }
  }

  const at = new Date().toISOString();
  const base = at.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  let file = `${base}.cpp`;
  let n = 1;
  while (fs.existsSync(path.join(dir, file))) file = `${base}-${++n}.cpp`;
  atomicWrite(path.join(dir, file), text);

  const entry = { file, at, label: String(label).slice(0, 60), result: String(result).slice(0, 16), lines: text.split("\n").length };
  let index = [entry, ...snapIndex(dir).filter((e) => e.file !== file)];

  // 只留最近 KEEP_VERSIONS 版（多余的文件一并删掉）
  const keep = new Set(before.slice(0, KEEP_VERSIONS - 1).map((x) => x.file));
  keep.add(file);
  for (const x of before) {
    if (!keep.has(x.file)) { try { fs.rmSync(path.join(dir, x.file), { force: true }); } catch { /* 忽略 */ } }
  }
  index = index.filter((e) => keep.has(e.file));
  atomicWrite(path.join(dir, "index.json"), JSON.stringify(index, null, 2));

  return { id: file.replace(/\.cpp$/, ""), file, at, label: entry.label, result: entry.result, bytes: Buffer.byteLength(text), lines: entry.lines, deduped: false };
}

/** 读某一版的代码 */
export function readSnapshot(pid, id) {
  const dir = snapDir(pid);
  const file = `${path.basename(String(id ?? ""))}.cpp`;
  const target = path.join(dir, file);
  if (!target.startsWith(dir) || !fs.existsSync(target)) throw new Error("这个版本不存在（可能已被清理）");
  return fs.readFileSync(target, "utf8");
}

/** 删掉某一版 */
export function deleteSnapshot(pid, id) {
  const dir = snapDir(pid);
  const file = `${path.basename(String(id ?? ""))}.cpp`;
  const target = path.join(dir, file);
  if (!target.startsWith(dir) || !fs.existsSync(target)) throw new Error("这个版本不存在（可能已被清理）");
  fs.rmSync(target, { force: true });
  atomicWrite(path.join(dir, "index.json"), JSON.stringify(snapIndex(dir).filter((e) => e.file !== file), null, 2));
  return listSnapshots(pid);
}

/* ============================ 导出 Markdown（按范围） ============================ */

/** GitHub 风格标题锚点：小写、空格转 -、去掉标点（保留中英文数字） */
export function mdAnchor(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 按范围导出 Markdown：
 *   scope="all"      → 整个档案（和 toMarkdown 一致，但可选加目录）
 *   scope="current"  → targetId 指定的题目（单题）或文件夹（该文件夹内所有题）
 * toc=true 且题目多于 1 道时，插入一份带锚点链接的目录。
 */
export function toMarkdownScoped(doc = load(), { scope = "all", targetId = null, toc = true } = {}) {
  const d = migrateDoc(doc ?? load());
  let nodes = d.tree ?? [];
  let title = d.title || "我的刷题本";

  if (scope === "current" && targetId) {
    const hit = findNode(d.tree ?? [], targetId);
    const node = hit?.node;
    if (node?.kind === "folder") {
      nodes = node.children ?? [];
      title = node.name;
    } else if (node?.kind === "problem") {
      nodes = [node];
      title = `${node.pid} ${node.title}`.trim();
    }
  }

  const problems = flattenProblems(nodes);
  const out = [`# ${title}`, ""];
  out.push(`> 导出时间：${new Date().toLocaleString("zh-CN")}　·　共 ${problems.length} 道题`, "");

  if (toc && problems.length > 1) {
    out.push("## 目录", "");
    problems.forEach((p, i) => {
      out.push(`${i + 1}. [${p.pid} ${p.title}](#${mdAnchor(`${p.pid} ${p.title}`)})`);
    });
    out.push("");
  }

  const emit = (list, depth) => {
    for (const node of list ?? []) {
      if (node.kind === "folder") {
        out.push(`${"#".repeat(Math.min(depth + 1, 6))} ${node.name}`, "");
        emit(node.children, depth + 1);
      } else if (node.kind === "problem") {
        out.push(problemToMarkdown(node, Math.min(depth + 1, 6)), "");
      }
    }
  };
  emit(nodes, 1);
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
