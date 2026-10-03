/* 洛谷刷题本 · 前端逻辑
   数据在后端 data/notebooks/<档案>.json，每次保存同步导出同名 .md */
"use strict";

/* ============================ 状态 ============================ */
const S = {
  doc: { title: t("doc.defaultTitle"), tree: [] },
  currentId: null,
  selected: new Set(),
  undo: [],
  profiles: { active: "default", list: [] },
  env: {},
  themes: [],
  styles: [],
  filters: { status: new Set(), diff: new Set(), tags: new Set(), q: "" },
  sync: null,
  saveTimer: null,
  running: false,
  backfilling: new Set(),
  tab: "io",
};

const STATUS_TEXT = {
  get todo() { return t("status.todo"); },
  get ac() { return t("status.ac"); },
  get review() { return t("status.review"); },
  get stuck() { return t("status.stuck"); },
};
const DIFF = {
  0: { get name() { return t("diff.0"); }, color: "#9aa7b4" }, 1: { get name() { return t("diff.1"); }, color: "#fe4c61" },
  2: { get name() { return t("diff.2"); }, color: "#f39c11" }, 3: { get name() { return t("diff.3"); }, color: "#ffc116" },
  4: { get name() { return t("diff.4"); }, color: "#52c41a" }, 5: { get name() { return t("diff.5"); }, color: "#3498db" },
  6: { get name() { return t("diff.6"); }, color: "#9d3dcf" }, 7: { get name() { return t("diff.7"); }, color: "#0e1d69" },
};

/* ============================ 工具 ============================ */
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function uid(p = "n") { return `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function diffOf(p) { return DIFF[p.difficulty] ?? DIFF[0]; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let toastTimer = null;
function toast(msg, isErr = false, ms = 2600, undoable = false) {
  const el = $("toast");
  $("toastText").textContent = msg;
  el.classList.toggle("err", isErr);
  $("toastUndo").classList.toggle("hidden", !undoable);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (json.ok === false) throw new Error(json.error || t("error.requestFailed", { status: res.status }));
  return json;
}
function download(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ============================ 撤销栈 ============================ */
function pushUndo(label) {
  try {
    S.undo.push({ label, snapshot: JSON.stringify(S.doc.tree), at: Date.now() });
    // 正在编辑的题目也一起存，避免撤销后内容错位
    if (S.undo.length > 40) S.undo.shift();
  } catch { /* 忽略 */ }
}
function undo() {
  const last = S.undo.pop();
  if (!last) return toast(t("toast.noUndo"), true);
  try {
    S.doc.tree = JSON.parse(last.snapshot);
    if (!findEntry(S.currentId)) S.currentId = null;
    S.selected.clear();
    markDirty();
    renderOutline();
    renderProblem();
    renderBatchBar();
    toast(t("toast.undone", { label: last.label }));
  } catch (e) {
    toast(t("toast.undoFailed", { message: e.message }), true);
  }
}
function withUndo(label, fn) {
  pushUndo(label);
  const r = fn();
  markDirty();
  renderOutline();
  return r;
}

/* ============================ 树 ============================ */
function walk(nodes, fn, parent = null) {
  for (const n of nodes ?? []) {
    fn(n, parent);
    if (n.kind === "folder") walk(n.children ?? [], fn, n);
  }
}
function findEntry(id) {
  let hit = null;
  walk(S.doc.tree, (n, parent) => { if (!hit && n.id === id) hit = { node: n, parent }; });
  return hit;
}
function findList(id) {
  const search = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.id === id) return nodes;
      if (n.kind === "folder") { const r = search(n.children); if (r) return r; }
    }
    return null;
  };
  return search(S.doc.tree);
}
function removeNode(id) {
  const list = findList(id);
  if (!list) return null;
  const i = list.findIndex((n) => n.id === id);
  return i < 0 ? null : list.splice(i, 1)[0];
}
function insertNode(targetId, pos, node) {
  if (pos === "into") {
    const t = findEntry(targetId);
    if (!t || t.node.kind !== "folder") return false;
    t.node.children = t.node.children ?? [];
    t.node.children.unshift(node);
    t.node.collapsed = false;
    return true;
  }
  const list = findList(targetId);
  if (!list) return false;
  const i = list.findIndex((n) => n.id === targetId);
  if (i < 0) return false;
  list.splice(pos === "after" ? i + 1 : i, 0, node);
  return true;
}
function isDescendant(folder, id) {
  if (!folder || folder.kind !== "folder") return false;
  let found = false;
  walk(folder.children ?? [], (n) => { if (n.id === id) found = true; });
  return found;
}
function flattenProblems(nodes = S.doc.tree) {
  const out = [];
  walk(nodes, (n) => { if (n.kind === "problem") out.push(n); });
  return out;
}
function allFolders() {
  const out = [];
  walk(S.doc.tree, (n) => { if (n.kind === "folder") out.push(n); });
  return out;
}
function depthOf(id) {
  let depth = 0;
  const search = (nodes, d) => {
    for (const n of nodes ?? []) {
      if (n.id === id) { depth = d; return true; }
      if (n.kind === "folder" && search(n.children, d + 1)) return true;
    }
    return false;
  };
  search(S.doc.tree, 0);
  return depth;
}
function newFolder(name = t("folder.new")) {
  return { id: uid("f"), kind: "folder", name, collapsed: false, children: [] };
}
function currentProblem() {
  const e = findEntry(S.currentId);
  return e && e.node.kind === "problem" ? e.node : null;
}
/** 选中集合里去掉「已被其它选中项包含」的节点 */
function topLevelSelection() {
  const ids = [...S.selected];
  const nodes = ids.map((id) => findEntry(id)?.node).filter(Boolean);
  const out = [];
  for (const n of nodes) {
    const covered = nodes.some((o) => o !== n && o.kind === "folder" && isDescendant(o, n.id));
    if (!covered) out.push(n);
  }
  return out;
}

/* ============================ Markdown ============================ */
const KATEX_DELIMS = [
  { left: "$$", right: "$$", display: true }, { left: "\\[", right: "\\]", display: true },
  { left: "$", right: "$", display: false }, { left: "\\(", right: "\\)", display: false },
];
if (window.marked) marked.setOptions({ gfm: true, breaks: true });

function mdToHtml(md) {
  if (!md) return "";
  let html;
  try { html = marked.parse(String(md)); } catch { html = `<p>${esc(md)}</p>`; }
  return window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ["target", "align"] }) : html;
}
function renderMath(root) {
  if (!window.renderMathInElement || !root) return;
  try {
    renderMathInElement(root, {
      delimiters: KATEX_DELIMS, throwOnError: false, strict: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
    });
  } catch {}
}
function problemMarkdown(p, { includeStatement = true, includeNote = true } = {}) {
  const out = [];
  if (includeStatement) {
    if (p.description) out.push("### " + t("problem.heading.description"), "", p.description, "");
    if (p.formatI) out.push("### " + t("problem.heading.input"), "", p.formatI, "");
    if (p.formatO) out.push("### " + t("problem.heading.output"), "", p.formatO, "");
    if (p.hint) out.push("### " + t("problem.heading.hint"), "", p.hint, "");
  }
  if (includeNote && p.note) out.push("### " + t("problem.heading.note"), "", p.note, "");
  return out.join("\n");
}

/* ============================ 大纲 ============================ */
function nodeMatches(p) {
  const f = S.filters;
  if (f.status.size && !f.status.has(p.status ?? "todo")) return false;
  if (f.diff.size && !f.diff.has(String(p.difficulty ?? 0))) return false;
  if (f.tags.size && !(p.tagNames ?? []).some((t) => f.tags.has(t))) return false;
  if (f.q) {
    const hay = [p.pid, p.title, (p.tagNames ?? []).join(" "), p.code, p.note, p.description]
      .join("\n").toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}
function hasFilter() {
  const f = S.filters;
  return Boolean(f.status.size || f.diff.size || f.tags.size || f.q);
}
function filterTree(nodes) {
  const active = hasFilter();
  const out = [];
  for (const n of nodes ?? []) {
    if (n.kind === "folder") {
      const kids = filterTree(n.children ?? []);
      const selfHit = active && S.filters.q && n.name.toLowerCase().includes(S.filters.q.toLowerCase());
      if (!active || kids.length || selfHit) out.push({ node: n, children: kids });
    } else if (!active || nodeMatches(n)) {
      out.push({ node: n, children: [] });
    }
  }
  return out;
}

function renderOutline() {
  const ul = $("outline");
  ul.innerHTML = "";
  const active = hasFilter();
  const rows = [];

  const renderNodes = (entries, depth, parentEl) => {
    for (const entry of entries) {
      const node = entry.node;
      const li = document.createElement("li");
      li.className = "row";
      li.dataset.id = node.id;
      li.style.paddingLeft = `${6 + depth * 14}px`;
      li.draggable = true;
      if (S.selected.has(node.id)) li.classList.add("multi");

      if (node.kind === "folder") {
        let count = 0;
        walk(node.children ?? [], (n) => { if (n.kind === "problem") count++; });
        li.classList.add("folder");
        if (node.id === S.currentId) li.classList.add("sel");
        li.innerHTML =
          `<span class="tw" title="${t("title.expandCollapse")}">${node.collapsed && !active ? "▶" : "▼"}</span>` +
          `<span class="f-icon">📁</span>` +
          `<span class="o-title">${esc(node.name)}</span>` +
          `<span class="o-count">${count}</span>` +
          `<button class="o-del" title="${t("title.deleteFolder")}">✕</button>`;
        li.querySelector(".tw").onclick = (e) => {
          e.stopPropagation();
          node.collapsed = !node.collapsed;
          markDirty();
          renderOutline();
        };
        li.querySelector(".o-del").onclick = (e) => { e.stopPropagation(); deleteNodes([node]); };
        li.onclick = (e) => onRowClick(e, node);
        li.ondblclick = async (e) => {
          e.stopPropagation();
          const name = await askText(t("prompt.renameFolder"), node.name);
          if (name != null && name.trim()) { node.name = name.trim(); markDirty(); renderOutline(); }
        };
        parentEl.appendChild(li);
        rows.push(li);
        if (!node.collapsed || active) renderNodes(entry.children, depth + 1, parentEl);
      } else {
        const d = diffOf(node);
        li.classList.add("problem");
        if (node.id === S.currentId) li.classList.add("sel");
        if (node.stub) li.classList.add("stub");
        li.innerHTML =
          `<span class="o-diff" style="background:${d.color}" title="${esc(d.name)}"></span>` +
          `<span class="o-pid">${esc(node.pid)}</span>` +
          `<span class="o-title" title="${esc(node.title)}">${esc(node.title)}</span>` +
          (node.stub ? `<span class="o-stub" title="${t("title.stub")}">${t("outline.stub")}</span>` : "") +
          `<span class="o-dot ${esc(node.status ?? "todo")}" title="${esc(STATUS_TEXT[node.status ?? "todo"])}"></span>` +
          `<button class="o-del" title="${t("title.delete")}">✕</button>`;
        li.querySelector(".o-del").onclick = (e) => { e.stopPropagation(); deleteNodes([node]); };
        li.onclick = (e) => onRowClick(e, node);
        parentEl.appendChild(li);
        rows.push(li);
      }
    }
  };

  renderNodes(filterTree(S.doc.tree), 0, ul);
  $("emptyHint").classList.toggle("hidden", flattenProblems().length > 0);
  renderFilters();
  renderBatchBar();
  attachDrag();
}

/* ------- 多选 ------- */
let lastClickedId = null;
function onRowClick(e, node) {
  if (e.ctrlKey || e.metaKey) {
    S.selected.has(node.id) ? S.selected.delete(node.id) : S.selected.add(node.id);
    lastClickedId = node.id;
    selectNode(node.id, { keepSelection: true });
    return;
  }
  if (e.shiftKey && lastClickedId) {
    const ids = [...document.querySelectorAll("#outline .row")].map((r) => r.dataset.id);
    const a = ids.indexOf(lastClickedId), b = ids.indexOf(node.id);
    if (a >= 0 && b >= 0) {
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.selected.add(ids[i]);
      selectNode(node.id, { keepSelection: true });
      return;
    }
  }
  S.selected.clear();
  S.selected.add(node.id);
  lastClickedId = node.id;
  selectNode(node.id, { keepSelection: true });
}
function selectNode(id, { keepSelection = false } = {}) {
  S.currentId = id;
  if (!keepSelection) {
    S.selected.clear();
    if (id) S.selected.add(id);
  }
  const p = currentProblem();
  renderOutline();
  renderProblem();
  if (p) {
    $("statusSelect").value = p.status ?? "todo";
    $("timeLimit").value = p.timeLimit ?? 1000;
    setEditorCode(p.code ?? "");
    $("stdin").value = p.lastStdin !== undefined ? p.lastStdin : (p.samples?.[0]?.input ?? "");
    $("expected").value = p.lastExpected !== undefined ? p.lastExpected : (p.samples?.[0]?.output ?? "");
    renderTests();
    paintEditor();
    if (p.stub) backfill(p);
  } else {
    setEditorCode("");
    $("stdin").value = "";
    $("expected").value = "";
    renderTests();
  }
  setResult(null);
}
function renderBatchBar() {
  const bar = $("batchBar");
  const n = S.selected.size;
  bar.classList.toggle("hidden", n === 0);
  $("batchCount").textContent = t("batch.selected", { n });
}
function clearSelection() {
  S.selected.clear();
  renderOutline();
}

/* ------- 框选 ------- */
function setupMarquee() {
  const scroll = $("outlineScroll");
  const box = $("marquee");
  let start = null;
  let base = new Set();

  scroll.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".row")) return;       // 点到行上是普通点击
    if (e.target.closest("button")) return;
    const rect = scroll.getBoundingClientRect();
    start = { x: e.clientX - rect.left + scroll.scrollLeft, y: e.clientY - rect.top + scroll.scrollTop };
    base = e.ctrlKey || e.metaKey ? new Set(S.selected) : new Set();
    box.classList.remove("hidden");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!start) return;
    const rect = scroll.getBoundingClientRect();
    const cur = { x: e.clientX - rect.left + scroll.scrollLeft, y: e.clientY - rect.top + scroll.scrollTop };
    const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
    const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
    Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });

    const sel = new Set(base);
    const scrollRect = scroll.getBoundingClientRect();
    for (const row of document.querySelectorAll("#outline .row")) {
      const r = row.getBoundingClientRect();
      const ry = r.top - scrollRect.top + scroll.scrollTop;
      const rx = r.left - scrollRect.left + scroll.scrollLeft;
      const hit = !(ry > y + h || ry + r.height < y || rx > x + w || rx + r.width < x);
      if (hit) sel.add(row.dataset.id);
    }
    S.selected = sel;
    for (const row of document.querySelectorAll("#outline .row")) {
      row.classList.toggle("multi", S.selected.has(row.dataset.id));
    }
    renderBatchBar();
  });

  window.addEventListener("mouseup", () => {
    if (!start) return;
    start = null;
    box.classList.add("hidden");
    box.style.width = "0px";
    box.style.height = "0px";
  });
}

/* ------- 拖拽 ------- */
let dragId = null;
function zoneFor(li, node, clientY) {
  const r = li.getBoundingClientRect();
  const y = clientY - r.top;
  if (node.kind === "folder" && y > r.height * 0.3 && y < r.height * 0.7) return "into";
  return y < r.height / 2 ? "before" : "after";
}
function clearDropMarks() {
  for (const el of $("outline").querySelectorAll(".drop-before,.drop-after,.drop-into")) {
    el.classList.remove("drop-before", "drop-after", "drop-into");
  }
  $("rootDrop").classList.remove("hot");
}
function attachDrag() {
  for (const li of [...$("outline").children]) {
    li.ondragstart = (e) => {
      dragId = li.dataset.id;
      // 拖一个未选中的项时，先把选中集合改成它
      if (!S.selected.has(dragId)) { S.selected.clear(); S.selected.add(dragId); }
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragId); } catch {}
    };
    li.ondragend = () => { li.classList.remove("dragging"); clearDropMarks(); dragId = null; };
    li.ondragover = (e) => {
      if (!dragId || dragId === li.dataset.id) return;
      const entry = findEntry(li.dataset.id);
      if (!entry) return;
      const dragged = findEntry(dragId)?.node;
      if (dragged?.kind === "folder" && (entry.node.id === dragId || isDescendant(dragged, entry.node.id))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const zone = zoneFor(li, entry.node, e.clientY);
      clearDropMarks();
      li.classList.add(zone === "into" ? "drop-into" : zone === "before" ? "drop-before" : "drop-after");
    };
    li.ondragleave = () => li.classList.remove("drop-before", "drop-after", "drop-into");
    li.ondrop = (e) => {
      e.preventDefault();
      const entry = findEntry(li.dataset.id);
      clearDropMarks();
      if (!dragId || !entry) { dragId = null; return; }
      const zone = zoneFor(li, entry.node, e.clientY);
      moveSelection(dragId, entry.node.id, zone);
      dragId = null;
    };
  }
  $("rootDrop").classList.toggle("hidden", !dragId);
}
/** 拖动会把「所有选中项」一起搬过去 */
function moveSelection(srcId, targetId, pos) {
  const moving = S.selected.has(srcId) && S.selected.size > 1
    ? topLevelSelection().map((n) => n.id)
    : [srcId];
  if (moving.includes(targetId)) return;
  const target = findEntry(targetId)?.node;
  if (!target) return;
  for (const id of moving) {
    const n = findEntry(id)?.node;
    if (n?.kind === "folder" && (target.id === id || isDescendant(n, target.id))) {
      return toast(t("toast.cannotDropIntoChild"), true);
    }
  }
  pushUndo(moving.length > 1 ? t("undo.moveItems", { n: moving.length }) : t("undo.move"));
  let anchor = targetId, anchorPos = pos;
  for (const id of moving) {
    const node = removeNode(id);
    if (!node) continue;
    insertNode(anchor, anchorPos, node);
    // 第一项之后都插在它后面，保持相对顺序
    anchor = node.id;
    anchorPos = "after";
  }
  markDirty();
  renderOutline();
}
function bindRootDrop() {
  const rd = $("rootDrop");
  rd.ondragover = (e) => { if (!dragId) return; e.preventDefault(); rd.classList.add("hot"); };
  rd.ondragleave = () => rd.classList.remove("hot");
  rd.ondrop = (e) => {
    e.preventDefault();
    clearDropMarks();
    if (!dragId) return;
    const moving = S.selected.has(dragId) && S.selected.size > 1 ? topLevelSelection().map((n) => n.id) : [dragId];
    pushUndo(moving.length > 1 ? t("undo.moveToTopItems", { n: moving.length }) : t("undo.moveToTop"));
    for (const id of moving) {
      const node = removeNode(id);
      if (node) S.doc.tree.push(node);
    }
    markDirty();
    renderOutline();
    dragId = null;
  };
}

/* ------- 删除 ------- */
function deleteNodes(nodes) {
  if (!nodes?.length) return;
  pushUndo(nodes.length > 1 ? t("undo.deleteItems", { n: nodes.length }) : t("undo.deleteItem", { name: nodes[0].pid ?? nodes[0].name }));
  for (const n of nodes) removeNode(n.id);
  if (nodes.some((n) => n.id === S.currentId)) S.currentId = null;
  S.selected.clear();
  markDirty();
  renderOutline();
  renderProblem();
  const label = nodes.length > 1 ? t("toast.deletedItems", { n: nodes.length }) : t("toast.deletedItem", { name: nodes[0].pid ?? nodes[0].name });
  toast(t("toast.undoHint", { label }), false, 6000, true);
}

/* ------- 批量操作 ------- */
async function batchMove() {
  const nodes = topLevelSelection();
  if (!nodes.length) return;
  const target = await pickFolder(t("pick.folderTitle", { n: nodes.length }));
  if (!target) return;
  pushUndo(t("undo.moveItems", { n: nodes.length }));
  for (const n of nodes) {
    removeNode(n.id);
    insertNode(target, "into", n);
  }
  markDirty();
  renderOutline();
  toast(t("toast.movedToFolder"));
}
function pickFolder(title) {
  $("pickTitle").textContent = title;
  const sel = $("pickSelect");
  sel.innerHTML = `<option value="__root__">${t("pick.rootOption")}</option>` +
    allFolders().map((f) => `<option value="${f.id}">${"　".repeat(depthOf(f.id))}📁 ${esc(f.name)}</option>`).join("");
  $("pickPanel").classList.remove("hidden");
  return new Promise((res) => {
    $("pickOk").onclick = () => {
      $("pickPanel").classList.add("hidden");
      res(sel.value === "__root__" ? "__root__" : sel.value);
    };
  });
}
function batchStatus(status) {
  const nodes = topLevelSelection();
  let n = 0;
  pushUndo(t("undo.batchStatus"));
  for (const node of nodes) {
    if (node.kind === "problem") { node.status = status; n++; }
    else walk(node.children ?? [], (c) => { if (c.kind === "problem") { c.status = status; n++; } });
  }
  markDirty();
  renderOutline();
  renderProblem();
  toast(t("toast.batchStatus", { n, status: STATUS_TEXT[status] }), false, 4000, true);
}

/* ============================ 筛选条 ============================ */
function renderFilters() {
  const problems = flattenProblems();
  const sf = $("statusFilters");
  sf.innerHTML = "";
  for (const key of ["todo", "ac", "review", "stuck"]) {
    const n = problems.filter((p) => (p.status ?? "todo") === key).length;
    if (!n) continue;
    const b = document.createElement("button");
    b.className = "chip" + (S.filters.status.has(key) ? " on" : "");
    b.innerHTML = `${esc(STATUS_TEXT[key])}<span class="n">${n}</span>`;
    b.onclick = () => toggleSet(S.filters.status, key);
    sf.appendChild(b);
  }
  const df = $("diffFilters");
  df.innerHTML = "";
  const byDiff = new Map();
  for (const p of problems) byDiff.set(String(p.difficulty ?? 0), (byDiff.get(String(p.difficulty ?? 0)) ?? 0) + 1);
  for (const key of [...byDiff.keys()].sort((a, b) => Number(a) - Number(b))) {
    const b = document.createElement("button");
    b.className = "chip" + (S.filters.diff.has(key) ? " on" : "");
    b.innerHTML = `${esc(DIFF[key]?.name ?? key)}<span class="n">${byDiff.get(key)}</span>`;
    b.onclick = () => toggleSet(S.filters.diff, key);
    df.appendChild(b);
  }
  const tf = $("tagFilters");
  tf.innerHTML = "";
  const byTag = new Map();
  for (const p of problems) for (const t of p.tagNames ?? []) byTag.set(t, (byTag.get(t) ?? 0) + 1);
  for (const [tag, n] of [...byTag].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const b = document.createElement("button");
    b.className = "chip" + (S.filters.tags.has(tag) ? " on" : "");
    b.innerHTML = `${esc(tag)}<span class="n">${n}</span>`;
    b.onclick = () => toggleSet(S.filters.tags, tag);
    tf.appendChild(b);
  }
  $("clearFilters").classList.toggle("hidden", !hasFilter());
}
function toggleSet(set, key) {
  set.has(key) ? set.delete(key) : set.add(key);
  renderOutline();
}
function clearAllFilters() {
  S.filters.status.clear(); S.filters.diff.clear(); S.filters.tags.clear(); S.filters.q = "";
  $("searchInput").value = "";
}

/* ============================ 题目面板 ============================ */
function renderProblem() {
  const body = $("problemBody");
  const e = findEntry(S.currentId);
  const node = e?.node;
  const p = node?.kind === "problem" ? node : null;
  $("refreshProblem").disabled = !p;
  $("shareProblem").disabled = !p;
  $("deleteProblem").disabled = !node;
  $("statusSelect").disabled = !p;

  if (!node) {
    body.innerHTML = `<div class="empty-hint"><p class="dim">${t("problem.emptyHint")}</p></div>`;
    return;
  }
  if (node.kind === "folder") {
    const kids = [];
    walk(node.children ?? [], (n) => { if (n.kind === "problem") kids.push(n); });
    const ac = kids.filter((x) => x.status === "ac").length;
    body.innerHTML = `
      <div class="p-head">
        <div class="p-title-line"><span class="p-name">📁 ${esc(node.name)}</span></div>
        <div class="p-meta"><span>${t("folder.totalCount", { n: kids.length })}</span><span>${t("folder.acCount", { n: ac })}</span></div>
      </div>
      <div class="md-body">
        <h3>${t("folder.problemsTitle")}</h3>
        <ul>${kids.map((k) => `<li>${esc(k.pid)} ${esc(k.title)}　<span class="dim">${esc(STATUS_TEXT[k.status ?? "todo"])}</span></li>`).join("") || `<li class='dim'>${t("folder.empty")}</li>`}</ul>
      </div>
      <div class="md-body"><h3>${t("note.title")}</h3></div>
      <textarea id="noteBox" class="note-box" placeholder="${t("note.folderPlaceholder")}">${esc(node.note ?? "")}</textarea>`;
    const note = $("noteBox");
    note.style.cssText = "width:100%;min-height:90px;margin-top:6px;font-family:var(--sans);line-height:1.7;resize:vertical";
    note.oninput = debounce(() => { node.note = note.value; markDirty(); }, 400);
    return;
  }

  const d = diffOf(p);
  const mem = p.memoryLimit ? `${(p.memoryLimit / 1024).toFixed(0)} MB` : "—";
  const rate = p.totalSubmit ? `${((p.totalAccepted / p.totalSubmit) * 100).toFixed(1)}%` : "—";
  const badges = [
    `<span class="badge diff" style="background:${d.color}">${esc(p.difficultyName || d.name)}</span>`,
    ...(p.tagNames ?? []).map((t) => `<span class="badge tag">${esc(t)}</span>`),
  ].join("");
  const stName = STATUS_TEXT[p.status ?? "todo"];
  const stColor = { ac: "var(--ok)", review: "var(--review)", stuck: "var(--warn)", todo: "var(--fg-dim)" }[p.status ?? "todo"];

  const samples = (p.samples ?? []).map((s, i) => `
    <div class="sample-block">
      <div class="sample-label">${t("sample.inputLabel", { n: i + 1 })} <button class="copy-mini" data-copy="${esc(s.input)}">${t("sample.copy")}</button>
        <button class="copy-mini" data-use="${i}">${t("sample.fillToRun")}</button>
        <button class="copy-mini" data-save="${i}">${t("sample.saveAsTest")}</button></div>
      <pre class="sample-pre">${esc(s.input)}</pre>
      <div class="sample-label">${t("sample.outputLabel", { n: i + 1 })} <button class="copy-mini" data-copy="${esc(s.output)}">${t("sample.copy")}</button></div>
      <pre class="sample-pre">${esc(s.output)}</pre>
    </div>`).join("");

  const story = (p.background ?? "").trim();
  let storyBlock = "";
  if (story) {
    const preview = story.replace(/\s+/g, " ").slice(0, 46);
    const tail = preview ? t("problem.storyPreview", { preview: esc(preview) + (story.length > 46 ? "…" : "") }) : "";
    storyBlock = '<details class="story"><summary>' + t("problem.storySummary") + ' <span class="dim">' +
      t("problem.storyFolded", { n: story.length, tail }) + '</span></summary><div class="md-body">' + mdToHtml(story) + "</div></details>";
  }
  const storyNote = !p.description && story
    ? `<div class="story-note">${t("problem.storyNote")}</div>` : "";
  const stubNote = p.stub
    ? `<div class="story-note">${t("problem.stubNote")}<button id="backfillBtn" class="ghost" style="margin-left:6px">${t("problem.backfillNow")}</button></div>` : "";

  body.innerHTML = `
    <div class="p-head">
      <div class="p-title-line">
        <span class="p-pid">${esc(p.pid)}</span>
        <span class="p-name">${esc(p.title)}</span>
        <span class="badge" style="color:${stColor};border-color:${stColor}">${esc(stName)}</span>
      </div>
      <div class="p-badges">${badges}</div>
      <div class="p-meta">
        <span>${t("problem.timeLimit", { value: p.timeLimit ?? "—" })}</span><span>${t("problem.memory", { value: mem })}</span><span>${t("problem.passRate", { value: rate })}</span>
        <a href="${esc(p.url)}" target="_blank" rel="noreferrer">${t("problem.openOnLuogu")}</a>
      </div>
    </div>
    ${stubNote}${storyBlock}${storyNote}
    <div class="md-body">${mdToHtml(problemMarkdown(p))}</div>
    ${samples ? `<div class="md-body"><h3>${t("sample.title")}</h3>${samples}</div>` : ""}
    <div class="md-body"><h3>${t("note.title")}</h3></div>
    <textarea id="noteBox" class="note-box" placeholder="${t("note.problemPlaceholder")}">${esc(p.note ?? "")}</textarea>`;
  renderMath(body);

  const note = $("noteBox");
  note.style.cssText = "width:100%;min-height:80px;margin-top:6px;font-family:var(--sans);line-height:1.7;resize:vertical";
  note.oninput = debounce(() => { p.note = note.value; markDirty(); }, 400);
  if ($("backfillBtn")) $("backfillBtn").onclick = () => backfill(p);

  body.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast(t("toast.copiedToClipboard")));
  });
  body.querySelectorAll("[data-use]").forEach((b) => {
    b.onclick = () => {
      const s = (p.samples ?? [])[Number(b.dataset.use)];
      if (!s) return;
      $("stdin").value = s.input ?? "";
      $("expected").value = s.output ?? "";
      toast(t("toast.sampleFilled"));
    };
  });
  body.querySelectorAll("[data-save]").forEach((b) => {
    b.onclick = () => {
      const s = (p.samples ?? [])[Number(b.dataset.save)];
      if (!s) return;
      p.tests = p.tests ?? [];
      p.tests.push({ id: uid("t"), name: t("tests.sampleName", { n: Number(b.dataset.save) + 1 }), input: s.input ?? "", output: s.output ?? "" });
      markDirty();
      renderTests();
      toast(t("toast.savedAsTest"));
    };
  });
}

async function backfill(p) {
  if (!p || !p.stub || S.backfilling.has(p.id)) return;
  S.backfilling.add(p.id);
  try {
    const { problem } = await api("/api/problem/fetch", { pid: p.pid });
    Object.assign(p, problem, { id: p.id, status: p.status, code: p.code, note: p.note, tests: p.tests, stub: false });
    markDirty();
    renderOutline();
    if (S.currentId === p.id) renderProblem();
    toast(t("toast.backfilled", { pid: p.pid }));
  } catch (e) {
    toast(t("toast.backfillFailed", { message: e.message }), true);
  } finally {
    S.backfilling.delete(p.id);
  }
}

/* ============================ 编辑器 ============================ */
const CPP_KEY = "alignas|alignof|and|asm|auto|break|case|catch|class|const|constexpr|continue|decltype|default|delete|do|dynamic_cast|else|enum|explicit|export|extern|false|for|friend|goto|if|inline|mutable|namespace|new|noexcept|nullptr|operator|or|private|protected|public|register|reinterpret_cast|return|sizeof|static|static_assert|static_cast|struct|switch|template|this|throw|true|try|typedef|typeid|typename|union|using|virtual|volatile|while|not|xor|bitand|bitor";
const CPP_TYP = "bool|char|char16_t|char32_t|double|float|int|long|short|signed|unsigned|void|wchar_t|size_t|string|vector|map|set|pair|queue|stack|deque|priority_queue|unordered_map|unordered_set|array|bitset|tuple|complex|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|ll|ull";

function highlight(code) {
  const rx = new RegExp(
    "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)" +
    "|(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')" +
    "|(^[ \\t]*#[^\\n]*)" +
    "|(\\b\\d[\\w.]*\\b)" +
    `|\\b(?:${CPP_KEY})\\b` + `|\\b(?:${CPP_TYP})\\b` +
    "|\\b([A-Za-z_]\\w*)(?=\\s*\\()", "gm"
  );
  const cls = ["tk-com", "tk-str", "tk-pre", "tk-num", "tk-key", "tk-typ", "tk-fn"];
  const src = String(code ?? "");
  let out = "", last = 0, m;
  while ((m = rx.exec(src))) {
    out += esc(src.slice(last, m.index));
    const gi = m.slice(1).findIndex((g) => g !== undefined);
    out += `<span class="${cls[gi]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) rx.lastIndex++;
  }
  return out + esc(src.slice(last));
}

const editor = { ta: null, hl: null, gutter: null, raf: null };
function paintEditor() {
  const code = editor.ta.value;
  if (editor.raf) cancelAnimationFrame(editor.raf);
  editor.raf = requestAnimationFrame(() => {
    editor.hl.innerHTML = highlight(code) + "\n";
    const lines = code.split("\n").length;
    if (editor.forceGutter || editor._lastLines !== lines) {
      editor.forceGutter = false;
      editor._lastLines = lines;
      let html = "";
      for (let i = 1; i <= lines; i++) html += `<div>${i}</div>`;
      editor.gutter.innerHTML = html;
    }
    syncScroll();
  });
  updateSaveState();
  if (currentProblem()) markDirty();
}
function syncScroll() {
  const t = editor.ta;
  editor.hl.parentElement.style.transform = `translate(${-t.scrollLeft}px, ${-t.scrollTop}px)`;
  editor.gutter.style.transform = `translateY(${-t.scrollTop}px)`;
}
function setEditorCode(code) {
  editor.ta.value = code ?? "";
  editor.forceGutter = true;
  paintEditor();
  editor.ta.scrollTop = 0;
  editor.ta.scrollLeft = 0;
  syncScroll();
}
/** 跳转到指定行并选中（编译错误点击用） */
function gotoLine(line) {
  const ta = editor.ta;
  const lines = ta.value.split("\n");
  const idx = Math.min(Math.max(1, line), lines.length);
  let pos = 0;
  for (let i = 0; i < idx - 1; i++) pos += lines[i].length + 1;
  ta.focus();
  ta.setSelectionRange(pos, pos + (lines[idx - 1]?.length ?? 0));
  const lh = 20.8;
  ta.scrollTop = Math.max(0, (idx - 1) * lh - ta.clientHeight / 2);
  ta.scrollLeft = 0;
  syncScroll();
  ta.classList.add("flash");
  setTimeout(() => ta.classList.remove("flash"), 700);
}
function setupEditorKeys() {
  const ta = editor.ta;
  const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b } = ta;
      if (a === b && !e.shiftKey) {
        ta.setRangeText("    ", a, b, "end");
      } else {
        const text = ta.value;
        const lineStart = text.lastIndexOf("\n", a - 1) + 1;
        const block = text.slice(lineStart, b);
        const shifted = e.shiftKey ? block.replace(/^ {1,4}/gm, "") : block.replace(/^/gm, "    ");
        ta.setRangeText(shifted, lineStart, b, "select");
      }
      paintEditor();
      return;
    }
    if (e.key === "Enter") {
      const { selectionStart: a, selectionEnd: b } = ta;
      const text = ta.value;
      const lineStart = text.lastIndexOf("\n", a - 1) + 1;
      const indent = (text.slice(lineStart, a).match(/^[ \t]*/) ?? [""])[0];
      const braces = (text[a - 1] === "{" && text[b] === "}") ? "\n" + indent + "    " : "";
      e.preventDefault();
      ta.setRangeText("\n" + indent + braces, a, b, "end");
      if (braces) {
        const pos = ta.selectionStart;
        ta.value = ta.value.slice(0, pos) + "\n" + indent + ta.value.slice(pos);
        ta.selectionStart = ta.selectionEnd = pos;
      }
      paintEditor();
      return;
    }
    if (PAIRS[e.key] && !e.ctrlKey && !e.altKey) {
      const { selectionStart: a, selectionEnd: b } = ta;
      if (a !== b) return;
      const next = ta.value[a] ?? "";
      if (['"', "'", "`"].includes(e.key)) {
        if (next === e.key) { e.preventDefault(); ta.selectionStart = ta.selectionEnd = a + 1; return; }
        if (/[\w)\]'"`]/.test(ta.value[a - 1] ?? "")) return;
      }
      e.preventDefault();
      ta.setRangeText(e.key + PAIRS[e.key], a, b, "end");
      ta.selectionStart = ta.selectionEnd = a + 1;
      paintEditor();
      return;
    }
    if ([")", "]", "}"].includes(e.key)) {
      const { selectionStart: a, selectionEnd: b } = ta;
      if (a === b && ta.value[a] === e.key) { e.preventDefault(); ta.selectionStart = ta.selectionEnd = a + 1; }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runCode(false); }
  });
  ta.addEventListener("input", paintEditor);
  ta.addEventListener("scroll", syncScroll);
  ta.addEventListener("click", updateSaveState);
  ta.addEventListener("paste", () => setTimeout(paintEditor, 0));
}

/* ============================ 运行 / 评测 ============================ */
function setResult(result, meta = "") {
  const body = $("resultBody");
  $("resultMeta").textContent = meta;
  if (!result) {
    body.className = "result-body dim";
    body.textContent = t("run.notRun");
    return;
  }
  body.className = "result-body";
  if (result.phase === "compile" || result.ok === false) {
    body.innerHTML = `<div><span class="verdict v-CE">${t("run.compileError")}</span></div>` + renderCompilerOutput(result.compileOutput || t("run.compileFailed"));
    bindErrorLinks(body);
    return;
  }
  if (!result.tests?.length) {
    body.innerHTML = `<span class="verdict v-DONE">${t("run.compileOk")}</span>\n${t("run.noTests")}`;
    return;
  }
  const parts = [];
  for (const tc of result.tests) {
    parts.push(`<div class="test-line">#${tc.tag} <span class="verdict v-${esc(tc.verdict)}">${esc(tc.verdict)}</span> ` +
      `<span class="k">${tc.timeMs} ms</span>${tc.verdict === "WA" ? ` <span class="k">${t("run.outputMismatch")}</span>` : ""}</div>`);
    if (tc.stdout) parts.push(`<div class="k">stdout:</div>${esc(tc.stdout)}`);
    if (tc.stderr) parts.push(`<div class="k">stderr:</div><span class="err-line">${esc(tc.stderr)}</span>`);
  }
  body.innerHTML = parts.join("\n");
}
/** 把 g++ 的报错渲染成可点击跳转的链接。
 *  注意路径里有盘符冒号（C:\...），所以不能简单用 [^:]* 去匹配文件名 */
function renderCompilerOutput(text) {
  const re = /^(.+?\.(?:cpp|cc|cxx|c\+\+|h|hpp)):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/gm;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const [, , line, col, kind] = m;
    const cls = kind.includes("error") ? "err-line" : kind === "warning" ? "warn-line" : "dim";
    out += `<a class="jump ${cls}" data-line="${line}" title="${t("title.jumpToLine", { line })}">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}
function bindErrorLinks(root) {
  root.querySelectorAll(".jump").forEach((a) => {
    a.onclick = () => gotoLine(Number(a.dataset.line));
  });
}
function collectTestsForJudge() {
  const p = currentProblem();
  const samples = p?.samples ?? [];
  if (samples.length) return samples.map((s) => ({ input: s.input, output: s.output }));
  if ((p?.tests ?? []).length) return p.tests.map((t) => ({ input: t.input, output: t.output }));
  toast(t("toast.noSamplesUseStdin"), true);
  return [{ input: $("stdin").value, output: $("expected").value }];
}
async function runCode(forJudge) {
  const p = currentProblem();
  if (!p) return toast(t("toast.pickProblemFirst"), true);
  if (S.running) return toast(t("toast.running"), true);
  const code = editor.ta.value;
  if (!code.trim()) return toast(t("toast.codeEmpty"), true);

  S.running = true;
  $("runBtn").disabled = $("judgeBtn").disabled = true;
  $("resultBody").className = "result-body dim";
  $("resultBody").textContent = t("run.compiling");
  $("resultMeta").textContent = "";
  try {
    const tests = forJudge
      ? collectTestsForJudge()
      : [{ input: $("stdin").value, output: $("expected").value, check: $("expected").value.trim() !== "" }];
    const { result } = await api("/api/run", {
      code, id: p.pid, tests,
      timeLimitMs: Math.max(100, Number($("timeLimit").value) || 1000),
    });
    const total = result.tests?.reduce((a, t) => a + t.timeMs, 0) ?? 0;
    setResult(result, result.ok ? t("run.summary", { n: result.tests?.length ?? 0, ms: total }) : t("run.compileFailed"));
    if (result.ok && forJudge && result.tests?.length && result.tests.every((t) => t.verdict === "AC")) {
      if ((p.status ?? "todo") !== "ac") {
        p.status = "ac";
        $("statusSelect").value = "ac";
        markDirty();
        renderOutline();
        toast(t("run.allPassedAuto"));
      } else toast(t("run.allPassed"));
    }
  } catch (e) {
    setResult({ ok: false, phase: "compile", compileOutput: e.message });
  } finally {
    S.running = false;
    $("runBtn").disabled = $("judgeBtn").disabled = false;
  }
}

/* ============================ 测试点 ============================ */
function renderTests() {
  const p = currentProblem();
  const list = $("testsList");
  const tests = p?.tests ?? [];
  $("tabTestCount").textContent = String(tests.length);
  if (!p) { list.innerHTML = `<div class="dim" style="padding:10px">${t("tests.pickProblem")}</div>`; return; }
  if (!tests.length) {
    list.innerHTML = `<div class="dim" style="padding:12px">${t("tests.none")}</div>`;
    return;
  }
  list.innerHTML = tests.map((tp, i) => `
    <div class="tp-item" data-id="${tp.id}">
      <div class="tp-head">
        <span class="tp-idx">#${i + 1}</span>
        <input class="tp-name" value="${esc(tp.name ?? "")}" placeholder="${t("tests.namePlaceholder")}">
        <button class="tp-run" title="${t("title.testSingle")}">${t("tests.runOne")}</button>
        <button class="tp-fill" title="${t("title.fillToStdin")}">${t("tests.fill")}</button>
        <button class="tp-del danger" title="${t("title.delete")}">✕</button>
        <span class="tp-verdict dim"></span>
      </div>
      <div class="tp-body">
        <textarea class="tp-in" spellcheck="false" placeholder="${t("tests.inputPlaceholder")}">${esc(tp.input ?? "")}</textarea>
        <textarea class="tp-out" spellcheck="false" placeholder="${t("tests.outputPlaceholder")}">${esc(tp.output ?? "")}</textarea>
      </div>
    </div>`).join("");

  list.querySelectorAll(".tp-item").forEach((el) => {
    const tp = tests.find((x) => x.id === el.dataset.id);
    el.querySelector(".tp-name").oninput = debounce((e) => { tp.name = e.target.value; markDirty(); }, 400);
    el.querySelector(".tp-in").oninput = debounce((e) => { tp.input = e.target.value; markDirty(); }, 400);
    el.querySelector(".tp-out").oninput = debounce((e) => { tp.output = e.target.value; markDirty(); }, 400);
    el.querySelector(".tp-del").onclick = () => {
      pushUndo(t("undo.deleteTest"));
      p.tests = tests.filter((x) => x.id !== tp.id);
      markDirty();
      renderTests();
    };
    el.querySelector(".tp-fill").onclick = () => {
      $("stdin").value = tp.input ?? "";
      $("expected").value = tp.output ?? "";
      switchTab("io");
      toast(t("toast.filledStdin"));
    };
    el.querySelector(".tp-run").onclick = async () => {
      const btn = el.querySelector(".tp-run");
      btn.disabled = true;
      try {
        const { result } = await api("/api/run", {
          code: editor.ta.value, id: p.pid,
          tests: [{ input: tp.input, output: tp.output, check: (tp.output ?? "").trim() !== "" }],
          timeLimitMs: Math.max(100, Number($("timeLimit").value) || 1000),
        });
        if (!result.ok) {
          el.querySelector(".tp-verdict").outerHTML = `<span class="tp-verdict verdict v-CE">CE</span>`;
          setResult(result, t("run.compileFailed"));
          return;
        }
        const r = result.tests[0];
        el.querySelector(".tp-verdict").outerHTML = `<span class="tp-verdict verdict v-${esc(r.verdict)}">${esc(r.verdict)}</span>`;
      } catch (e) {
        toast(e.message, true);
      } finally {
        btn.disabled = false;
      }
    };
  });
}
async function runAllTests() {
  const p = currentProblem();
  if (!p) return;
  if (!(p.tests ?? []).length) return toast(t("toast.noTests"), true);
  if (!editor.ta.value.trim()) return toast(t("toast.codeEmpty"), true);
  $("testsSummary").textContent = t("run.compiling");
  try {
    const { result } = await api("/api/run", {
      code: editor.ta.value, id: p.pid,
      tests: p.tests.map((t) => ({ input: t.input, output: t.output, check: (t.output ?? "").trim() !== "" })),
      timeLimitMs: Math.max(100, Number($("timeLimit").value) || 1000),
    });
    setResult(result, t("run.summarySelf", { n: p.tests.length }));
    if (result.ok) {
      const pass = result.tests.filter((t) => ["AC", "DONE"].includes(t.verdict)).length;
      $("testsSummary").textContent = t("tests.summary", { pass, total: result.tests.length });
      renderTests();
      const els = [...document.querySelectorAll(".tp-item .tp-verdict")];
      result.tests.forEach((t, i) => {
        if (els[i]) els[i].outerHTML = `<span class="tp-verdict verdict v-${esc(t.verdict)}">${esc(t.verdict)}</span>`;
      });
    } else {
      $("testsSummary").textContent = t("run.compileFailed");
    }
  } catch (e) {
    $("testsSummary").textContent = "";
    toast(e.message, true);
  }
}

/* ============================ 界面配色 ============================ */
const UI_THEMES = ["dark", "light", "amber"];
function applyTheme(theme) {
  const t = UI_THEMES.includes(theme) ? theme : "dark";
  document.documentElement.dataset.theme = t;
  const sel = $("themeSelect");
  if (sel) sel.value = t;
  S.env.uiTheme = t;
}

/* ============================ 标签页 ============================ */
function switchTab(name) {
  S.tab = name;
  for (const b of document.querySelectorAll("#tabs .tab")) b.classList.toggle("on", b.dataset.tab === name);
  for (const pane of document.querySelectorAll(".tab-pane")) {
    pane.classList.toggle("hidden", pane.dataset.pane !== name);
  }
}


/* ============================ 格式化 ============================ */
async function formatCurrent() {
  const p = currentProblem();
  if (!p) return toast(t("toast.pickProblemFirst"), true);
  const code = editor.ta.value;
  if (!code.trim()) return;
  const btn = $("formatBtn");
  btn.disabled = true;
  btn.textContent = t("format.running");
  try {
    const { code: out } = await api("/api/format", { code, style: S.env.style || "file" });
    pushUndo(t("undo.format"));
    setEditorCode(out);
    p.code = out;
    markDirty();
    toast(t("toast.formatted"));
  } catch (e) {
    toast(e.message.split("\n")[0], true, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = t("format.button");
  }
}

/* ============================ 保存 ============================ */
function markDirty() {
  updateSaveState(true);
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, 700);
}
function updateSaveState(dirty) {
  const el = $("saveState");
  if (dirty === undefined) dirty = el.classList.contains("dirty");
  el.textContent = dirty ? t("save.unsaved") : t("save.saved");
  el.classList.toggle("dirty", Boolean(dirty));
}
async function saveNow() {
  const p = currentProblem();
  if (p) {
    p.code = editor.ta.value;
    p.lastStdin = $("stdin").value;
    p.lastExpected = $("expected").value;
  }
  S.doc.title = $("docTitle").value.trim() || t("doc.defaultTitle");
  try {
    await api("/api/save", { doc: S.doc });
    updateSaveState(false);
  } catch (e) {
    updateSaveState(true);
    toast(t("toast.saveFailed", { message: e.message }), true);
  }
}

/* ============================ 档案 ============================ */
function renderProfiles() {
  const sel = $("profileSelect");
  sel.innerHTML = S.profiles.list.map((x) =>
    `<option value="${x.id}"${x.id === S.profiles.active ? " selected" : ""}>${esc(x.name)}</option>`).join("");
}
async function switchProfile(id) {
  if (id === S.profiles.active) return;
  await saveNow();
  try {
    const r = await api("/api/profile/switch", { id });
    S.profiles = r.profiles;
    await reloadDoc();
    toast(t("toast.switchedProfile", { name: S.profiles.list.find((x) => x.id === id)?.name }));
  } catch (e) {
    toast(e.message, true);
  }
}
async function reloadDoc() {
  const st = await api("/api/state");
  S.doc = st.doc;
  S.profiles = st.profiles;
  S.env = st.env;
  applyTheme(S.env.uiTheme || "dark");
  $("docTitle").value = S.doc.title ?? t("doc.defaultTitle");
  S.currentId = null;
  S.selected.clear();
  S.undo = [];
  renderProfiles();
  renderOutline();
  const first = flattenProblems()[0];
  if (first) selectNode(first.id);
  else renderProblem();
  updateSaveState(false);
}

/* ============================ 同步 ============================ */
function openSync() {
  $("syncUid").value = S.env.luoguUid || "";
  $("syncPanel").classList.remove("hidden");
  if (S.sync) renderSync(S.sync);
}
async function doSyncFetch() {
  const uid = $("syncUid").value.trim();
  if (!uid) return toast(t("toast.needUid"), true);
  const btn = $("syncFetch");
  btn.disabled = true;
  btn.textContent = t("sync.fetching");
  $("syncResult").innerHTML = `<span class="dim">${t("sync.fetchingHint")}</span>`;
  try {
    const r = await api("/api/sync/luogu", { uid });
    S.sync = r;
    S.env.luoguUid = uid;
    api("/api/config", { luoguUid: uid }).catch(() => {});
    renderSync(r);
  } catch (e) {
    $("syncResult").innerHTML = `<span class="err-line">${t("sync.fetchFailed", { message: esc(e.message) })}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = t("sync.fetchButton");
  }
}
function renderSync(r) {
  const localPids = new Set(flattenProblems().map((p) => p.pid));
  const todo = r.passed.filter((p) => !localPids.has(p.pid));
  const folderOpts = [`<option value="__root__">${t("sync.rootOption")}</option>`, `<option value="__new__">${t("sync.newFolderOption")}</option>`]
    .concat(allFolders().map((f) => `<option value="${f.id}">${"　".repeat(depthOf(f.id))}📁 ${esc(f.name)}</option>`))
    .join("");
  const diffCount = new Map();
  for (const p of todo) diffCount.set(p.difficulty, (diffCount.get(p.difficulty) ?? 0) + 1);

  $("syncResult").innerHTML = `
    <div class="sync-head">
      <span class="sync-user">${esc(r.user.name)}</span>
      <span class="dim">UID ${esc(String(r.user.uid))}</span>
      <span class="badge">${t("sync.passedBadge", { n: r.stats.passedTotal })}</span>
      <span class="badge">${t("sync.submittedBadge", { n: r.stats.submittedTotal })}</span>
    </div>
    <div class="sync-actions">
      <button id="syncStatusBtn" class="primary">${t("sync.syncStatusButton", { n: r.stats.alreadyLocal })}</button>
      <button id="syncImportBtn">${t("sync.importButton", { n: todo.length })}</button>
      <label class="inline">${t("sync.importTo")} <select id="syncTarget">${folderOpts}</select></label>
    </div>
    <div class="sync-list-head">
      <span class="dim">${t("sync.todoLabel")}</span>
      <button id="syncAll" class="link">${t("sync.selectAll")}</button>
      <button id="syncNone" class="link">${t("sync.selectNone")}</button>
      <span class="dim">${t("sync.byDifficulty")}</span>
      ${[...diffCount.keys()].sort((a, b) => a - b).map((k) =>
        `<span class="chip small" data-diff="${k}">${esc(DIFF[k]?.name ?? k)} ${diffCount.get(k)}</span>`).join("")}
    </div>
    <div class="sync-list" id="syncList">
      ${todo.length ? todo.map((p) => {
        const d = DIFF[p.difficulty] ?? DIFF[0];
        return `<label class="sync-item on" data-diff="${p.difficulty}">
          <input type="checkbox" checked value="${esc(p.pid)}">
          <span class="o-diff" style="background:${d.color}"></span>
          <span class="o-pid">${esc(p.pid)}</span>
          <span class="o-title">${esc(p.title)}</span>
          <span class="dim" style="font-size:11px">${esc(d.name)}</span>
        </label>`;
      }).join("") : `<div class="dim" style="padding:10px">${t("sync.nothingToImport")}</div>`}
    </div>`;

  const list = $("syncList");
  const refreshItem = (lab) => lab.classList.toggle("on", lab.querySelector("input").checked);
  list.querySelectorAll(".sync-item").forEach((lab) => { lab.querySelector("input").onchange = () => refreshItem(lab); });
  $("syncAll").onclick = () => list.querySelectorAll(".sync-item").forEach((l) => { l.querySelector("input").checked = true; refreshItem(l); });
  $("syncNone").onclick = () => list.querySelectorAll(".sync-item").forEach((l) => { l.querySelector("input").checked = false; refreshItem(l); });
  document.querySelectorAll(".sync-list-head [data-diff]").forEach((chip) => {
    chip.onclick = () => {
      const d = chip.dataset.diff;
      list.querySelectorAll(`.sync-item[data-diff="${d}"]`).forEach((lab) => {
        const box = lab.querySelector("input");
        box.checked = !box.checked;
        refreshItem(lab);
      });
    };
  });

  $("syncStatusBtn").onclick = () => {
    const passed = new Set(r.passed.map((p) => p.pid));
    pushUndo(t("undo.syncStatus"));
    let changed = 0;
    for (const p of flattenProblems()) {
      if (passed.has(p.pid) && p.status !== "ac") { p.status = "ac"; changed++; }
    }
    markDirty();
    renderOutline();
    renderProblem();
    toast(changed ? t("toast.markedAc", { n: changed }) : t("toast.syncAlreadyInSync"), false, 4000, changed > 0);
  };

  $("syncImportBtn").onclick = () => {
    const picked = [...list.querySelectorAll(".sync-item")]
      .filter((lab) => lab.querySelector("input").checked)
      .map((lab) => lab.querySelector("input").value);
    if (!picked.length) return toast(t("toast.nothingSelected"), true);
    const target = $("syncTarget").value;
    pushUndo(t("undo.importItems", { n: picked.length }));
    let dest;
    if (target === "__new__") { dest = newFolder(t("sync.folderName")); S.doc.tree.unshift(dest); }
    else if (target === "__root__") dest = null;
    else dest = findEntry(target)?.node ?? null;

    const byPid = new Map(r.passed.map((p) => [p.pid, p]));
    const nodes = picked.map((pid) => {
      const info = byPid.get(pid) ?? { pid, title: pid, difficulty: 0 };
      return {
        id: uid("p"), kind: "problem",
        pid: info.pid, title: info.title,
        difficulty: info.difficulty,
        difficultyName: (DIFF[info.difficulty] ?? DIFF[0]).name,
        tagNames: [], status: "ac", language: "cpp",
        code: "", note: "", tests: [],
        description: "", formatI: "", formatO: "", hint: "", samples: [], background: "",
        timeLimit: 1000, memoryLimit: 262144,
        url: `https://www.luogu.com.cn/problem/${info.pid}`,
        stub: true, addedAt: Date.now(),
      };
    });
    if (dest) { dest.children = dest.children ?? []; dest.children.unshift(...nodes); dest.collapsed = false; }
    else S.doc.tree.unshift(...nodes);
    markDirty();
    clearAllFilters();
    renderOutline();
    toast(t("toast.imported", { n: nodes.length }), false, 4000, true);
    $("syncPanel").classList.add("hidden");
  };
}

/* ============================ PDF ============================ */
function openPdf() {
  const box = $("pdfThemes");
  if (!box.children.length) {
    box.innerHTML = S.themes.map((t, i) =>
      `<label class="radio theme-opt"><input type="radio" name="pdfTheme" value="${esc(t.id)}"${i === 0 ? " checked" : ""}> ${esc(t.name)}</label>`).join("");
  }
  $("pdfPanel").classList.remove("hidden");
  loadPdfHistory();
}
async function loadPdfHistory() {
  try {
    const { files, dir } = await api("/api/export/list");
    if (!files.length) {
      $("pdfHistory").innerHTML = `<div class="dim" style="font-size:11.5px;margin-top:10px">${t("pdf.noHistory")}<code>${esc(dir)}</code></div>`;
      return;
    }
    $("pdfHistory").innerHTML = `<div class="pdf-history-title">${t("pdf.historyTitle")}</div>` +
      files.map((f) => `<div class="pdf-history-item">
        <a href="/api/export/download/${encodeURIComponent(f.name)}" download>${esc(f.name)}</a>
        <span class="dim">${(f.size / 1024).toFixed(0)} KB · ${new Date(f.at).toLocaleString("zh-CN")}</span></div>`).join("");
  } catch {}
}
async function doExportPdf() {
  const scope = document.querySelector("input[name=pdfScope]:checked").value;
  const theme = document.querySelector("input[name=pdfTheme]:checked").value;
  const layout = document.querySelector("input[name=pdfLayout]:checked").value;
  if (scope === "current" && !S.currentId) return toast(t("toast.pickProblemOrFolder"), true);
  const btn = $("pdfGo");
  btn.disabled = true;
  btn.textContent = t("pdf.generating");
  $("pdfStatus").innerHTML = `<span class="dim">${t("pdf.renderingHint")}</span>`;
  try {
    const r = await api("/api/export/pdf", {
      theme, scope, targetId: S.currentId,
      twoColumn: layout === "two", includeCode: $("pdfCode").checked, includeNote: $("pdfNote").checked,
    });
    $("pdfStatus").innerHTML = t("pdf.generated", { file: `<code>${esc(r.file)}</code>`, size: (r.size / 1024).toFixed(0) });
    const a = document.createElement("a");
    a.href = r.downloadUrl;
    a.download = r.file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    loadPdfHistory();
  } catch (e) {
    $("pdfStatus").innerHTML = `<span class="err-line">${t("pdf.failed", { message: esc(e.message) })}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = t("pdf.generateButton");
  }
}

/* ============================ 统计 ============================ */
function showStats() {
  const problems = flattenProblems();
  const ac = problems.filter((p) => p.status === "ac").length;
  const byDiff = new Map(), byTag = new Map(), byStatus = new Map(), acByTag = new Map();
  for (const p of problems) {
    byDiff.set(p.difficulty ?? 0, (byDiff.get(p.difficulty ?? 0) ?? 0) + 1);
    byStatus.set(p.status ?? "todo", (byStatus.get(p.status ?? "todo") ?? 0) + 1);
    for (const t of p.tagNames ?? []) byTag.set(t, (byTag.get(t) ?? 0) + 1);
  }
  for (const p of problems.filter((x) => x.status === "ac")) {
    for (const t of p.tagNames ?? []) acByTag.set(t, (acByTag.get(t) ?? 0) + 1);
  }
  const bar = (label, n, max, color = "var(--accent-2)", extra = "") =>
    `<div class="bar-row"><span class="lab" title="${esc(label)}">${esc(label)}</span>
      <span class="bar" style="width:${max ? Math.max(3, (n / max) * 140) : 3}px;background:${color}"></span>
      <span class="num">${n}${extra}</span></div>`;
  const diffs = [...byDiff].sort((a, b) => a[0] - b[0]);
  const maxD = Math.max(1, ...diffs.map((d) => d[1]));
  const tags = [...byTag].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const maxT = Math.max(1, ...tags.map((t) => t[1]));

  $("statsBody").innerHTML = `
    <div class="stats-grid">
      <div class="stat-block">
        <h4>${t("stats.overview")}</h4>
        <div class="big-num">${problems.length}</div>
        <div class="dim" style="margin-bottom:10px">${t("stats.summary", { ac, percent: problems.length ? ((ac / problems.length) * 100).toFixed(0) : 0 })}</div>
        ${bar(t("status.ac"), byStatus.get("ac") ?? 0, Math.max(1, problems.length), "var(--ok)")}
        ${bar(t("status.todo"), byStatus.get("todo") ?? 0, Math.max(1, problems.length), "var(--fg-dim-2)")}
        ${bar(t("status.review"), byStatus.get("review") ?? 0, Math.max(1, problems.length), "var(--review)")}
        ${bar(t("status.stuck"), byStatus.get("stuck") ?? 0, Math.max(1, problems.length), "var(--warn)")}
        <h4 style="margin-top:18px">${t("stats.difficultyTitle")}</h4>
        ${diffs.map(([k, n]) => bar(DIFF[k]?.name ?? k, n, maxD, DIFF[k]?.color ?? "#888")).join("") || `<div class="dim">${t("stats.noData")}</div>`}
      </div>
      <div class="stat-block">
        <h4>${t("stats.tagTitle")}</h4>
        ${tags.map(([t, n]) => bar(t, n, maxT, "var(--accent-2)", ` / ${acByTag.get(t) ?? 0}`)).join("") || `<div class="dim">${t("stats.noData")}</div>`}
      </div>
    </div>`;
  $("statsPanel").classList.remove("hidden");
}

/* ============================ 分享 ============================ */
async function shareCurrent() {
  const p = currentProblem();
  if (!p) return toast(t("toast.pickProblemFirst"), true);
  await saveNow();
  try {
    const r = await api("/api/problem/export", { id: p.id });
    download(r.file.endsWith(".json") ? r.file : `${p.pid}.json`, JSON.stringify(r.card, null, 2), "application/json");
    toast(t("toast.shareExported"));
  } catch (e) {
    toast(e.message, true);
  }
}
function importCardFile() {
  pickFile(".json", async (text) => {
    try {
      const r = await api("/api/problem/import", { card: JSON.parse(text), folderId: null });
      S.doc = r.doc;
      renderOutline();
      selectNode(r.node.id);
      toast(t("toast.importedCard", { pid: r.node.pid, title: r.node.title }), false, 4000, true);
    } catch (e) {
      toast(t("toast.importFailed", { message: e.message }), true);
    }
  });
}

/* ============================ Markdown / 导入导出 ============================ */
async function showMarkdown() {
  await saveNow();
  const { markdown } = await api("/api/markdown");
  $("mdBody").textContent = markdown;
  $("mdPanel").classList.remove("hidden");
}
let promptResolve = null;
function askText(title, value = "") {
  $("promptTitle").textContent = title;
  $("promptInput").value = value;
  $("promptPanel").classList.remove("hidden");
  setTimeout(() => $("promptInput").select(), 30);
  return new Promise((res) => { promptResolve = res; });
}
function closePrompt(v) {
  $("promptPanel").classList.add("hidden");
  if (promptResolve) { promptResolve(v); promptResolve = null; }
}
function pickFile(accept, cb) {
  const input = $("fileInput");
  input.accept = accept;
  input.value = "";
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => Promise.resolve(cb(String(reader.result))).catch((err) => toast(t("toast.importFailed", { message: err.message }), true));
    reader.readAsText(f, "utf-8");
  };
  input.click();
}

/* ============================ 设置 ============================ */
function showSettings() {
  const e = S.env ?? {};
  $("settingsBody").innerHTML = `
    <div class="set-grid">
      <div class="set-row">
        <label>${t("settings.gppLabel")}</label>
        <input id="setGpp" value="${esc(e.gpp ?? "")}" placeholder="D:\\royqh\\mingw64\\bin\\g++.exe">
      </div>
      <div class="set-row">
        <label>${t("settings.browserLabel")}</label>
        <input id="setBrowser" value="${esc(e.browser ?? "")}" placeholder="C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe">
      </div>
      <div class="set-row">
        <label>${t("settings.clangLabel")}</label>
        <div class="row-inline">
          <input id="setClang" value="${esc(e.clangFormat ?? "")}" placeholder="${t("settings.clangPlaceholder")}">
          <button id="dlClang" class="ghost" title="${t("title.downloadStandalone")}">${t("settings.download")}</button>
        </div>
      </div>
      <div class="set-row">
        <label>${t("settings.styleLabel")}</label>
        <select id="setStyle">${(S.styles ?? []).map((s) =>
          `<option value="${esc(s.id)}"${s.id === (e.style ?? "file") ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      </div>
      <div class="set-row">
        <label>${t("settings.uidLabel")}</label>
        <input id="setUid" value="${esc(e.luoguUid ?? "")}" placeholder="${t("settings.uidPlaceholder")}">
      </div>
      <div class="set-row">
        <label>${t("settings.repoLabel")}</label>
        <div class="row-inline">
          <input id="setRepo" value="${esc(e.repo ?? "")}" placeholder="${t("settings.repoPlaceholder")}">
          <button id="checkUpdate" class="ghost">${t("settings.checkUpdate")}</button>
        </div>
      </div>
      <div class="set-row">
        <label>${t("settings.profileLabel")}</label>
        <div id="profileList" class="profile-list"></div>
        <button id="newProfile" class="ghost" style="margin-top:6px">${t("settings.newProfile")}</button>
      </div>
    </div>
    <div class="set-note">
      ${t("settings.envLine", { node: esc(e.node ?? ""), platform: esc(e.platform ?? ""), version: esc(e.version ?? "") })}<br>
      ${t("settings.statusLine", {
        gpp: e.hasGpp ? t("settings.available") : t("settings.notFound"),
        browser: e.hasBrowser ? t("settings.available") : t("settings.notFound"),
        clang: e.clangFormat ? t("settings.available") : t("settings.notInstalled"),
      })}<br>
      ${t("settings.dataDir")}<code>${esc((S.env.paths?.json ?? "").replace(/[^\\/]+$/, ""))}</code><br>
      ${t("settings.pdfOut")}<code>${esc(S.env.paths?.exports ?? "exports")}</code>
    </div>
    <div id="updateInfo" class="dim" style="font-size:12px;margin-top:8px"></div>
    <div class="prompt-actions">
      <button class="ghost" data-close>${t("settings.close")}</button>
      <button id="saveSettings" class="primary">${t("settings.save")}</button>
    </div>`;
  $("settingsPanel").classList.remove("hidden");
  $("saveSettings").onclick = async () => {
    try {
      const r = await api("/api/config", {
        gpp: $("setGpp").value.trim(), browser: $("setBrowser").value.trim(),
        clangFormat: $("setClang").value.trim(), formatStyle: $("setStyle").value,
        luoguUid: $("setUid").value.trim(), repo: $("setRepo").value.trim(),
      });
      S.env = { ...S.env, ...r.env };
      toast(t("toast.settingsSaved"));
      $("settingsPanel").classList.add("hidden");
    } catch (err) {
      toast(t("toast.saveFailed", { message: err.message }), true);
    }
  };
  $("dlClang").onclick = async () => {
    const b = $("dlClang");
    b.disabled = true;
    b.textContent = t("settings.downloading");
    try {
      const r = await api("/api/format/download", {});
      $("setClang").value = r.file;
      toast(t("toast.downloaded", { file: r.file }), false, 5000);
    } catch (err) {
      toast(err.message.split("\n")[0], true, 8000);
    } finally {
      b.disabled = false;
      b.textContent = t("settings.download");
    }
  };
  $("checkUpdate").onclick = async () => {
    const info = $("updateInfo");
    info.textContent = t("settings.checking");
    try {
      const r = await api("/api/update/check", {});
      info.innerHTML = r.hasUpdate
        ? t("settings.updateAvailable", { latest: esc(r.latest), current: esc(r.current) }) +
          ` <a href="${esc(r.url)}" target="_blank">${t("settings.openDownloadPage")}</a>`
        : t("settings.upToDate", { current: esc(r.current) });
    } catch (err) {
      info.innerHTML = `<span class="err-line">${esc(err.message)}</span>`;
    }
  };
  renderProfileManager();
}

function renderProfileManager() {
  const box = $("profileList");
  if (!box) return;
  box.innerHTML = S.profiles.list.map((x) => `
    <div class="profile-row${x.id === S.profiles.active ? " on" : ""}">
      <button class="pf-switch" data-id="${x.id}" ${x.id === S.profiles.active ? "disabled" : ""}>
        ${x.id === S.profiles.active ? t("profileManager.current") : t("profileManager.switch")}
      </button>
      <span class="pf-name">${esc(x.name)}</span>
      <button class="pf-rename ghost" data-id="${x.id}">${t("profileManager.rename")}</button>
      <button class="pf-del danger" data-id="${x.id}">${t("profileManager.delete")}</button>
    </div>`).join("");

  box.querySelectorAll(".pf-switch").forEach((b) => {
    b.onclick = async () => {
      await switchProfile(b.dataset.id);
      renderProfileManager();
    };
  });
  box.querySelectorAll(".pf-rename").forEach((b) => {
    b.onclick = async () => {
      const cur = S.profiles.list.find((x) => x.id === b.dataset.id);
      const name = await askText(t("prompt.renameProfile"), cur?.name ?? "");
      if (name == null || !name.trim()) return;
      try {
        const r = await api("/api/profile/rename", { id: b.dataset.id, name: name.trim() });
        S.profiles = r.profiles;
        if (b.dataset.id === S.profiles.active) { S.doc.title = name.trim(); $("docTitle").value = name.trim(); }
        renderProfiles();
        renderProfileManager();
        toast(t("toast.renamed"));
      } catch (err) { toast(err.message, true); }
    };
  });
  box.querySelectorAll(".pf-del").forEach((b) => {
    b.onclick = async () => {
      if (!confirm(t("confirm.deleteProfile"))) return;
      try {
        const r = await api("/api/profile/delete", { id: b.dataset.id });
        S.profiles = r.profiles;
        await reloadDoc();
        renderProfileManager();
        toast(t("toast.deleted"));
      } catch (err) { toast(err.message, true); }
    };
  });
  const nb = $("newProfile");
  if (nb) {
    nb.onclick = async () => {
      const name = await askText(t("prompt.newProfile"), t("profileManager.defaultName"));
      if (name == null || !name.trim()) return;
      try {
        const r = await api("/api/profile/create", { name: name.trim() });
        S.profiles = r.profiles;
        await reloadDoc();
        renderProfileManager();
        toast(t("toast.profileCreated", { name: name.trim() }));
      } catch (err) { toast(err.message, true); }
    };
  }
}

/* ============================ 首启动向导 ============================ */
function showWizard() {
  const e = S.env ?? {};
  const item = (ok, title, desc, extra = "") =>
    `<div class="wiz-item ${ok ? "ok" : "bad"}">
       <span class="wiz-mark">${ok ? "✓" : "!"}</span>
       <div class="wiz-body"><div class="wiz-title">${title}</div><div class="dim">${desc}</div>${extra}</div>
     </div>`;
  $("wizardBody").innerHTML = `
    <p class="dim" style="margin-top:0">${t("wizard.intro")}</p>
    ${item(e.hasGpp, t("wizard.gppTitle"), e.hasGpp ? esc(e.gpp) : t("wizard.gppMissing"),
      e.hasGpp ? "" : `<button class="ghost" data-wiz="settings">${t("wizard.setGppPath")}</button>`)}
    ${item(e.hasBrowser, t("wizard.browserTitle"), e.hasBrowser ? esc(e.browser) : t("wizard.browserMissing"),
      e.hasBrowser ? "" : `<button class="ghost" data-wiz="settings">${t("wizard.setBrowserPath")}</button>`)}
    ${item(Boolean(e.clangFormat), t("wizard.clangTitle"), e.clangFormat ? esc(e.clangFormat) : t("wizard.clangMissing"),
      e.clangFormat ? "" : `<button class="ghost" data-wiz="settings">${t("wizard.setClangPath")}</button>`)}
    ${item(Boolean(e.luoguUid), t("wizard.syncTitle"), e.luoguUid ? `UID ${esc(e.luoguUid)}` : t("wizard.syncMissing"),
      e.luoguUid ? "" : `<button class="ghost" data-wiz="sync">${t("wizard.goSync")}</button>`)}
    <div class="set-note" style="margin-top:14px">
      ${t("wizard.dataNote", { version: esc(e.version ?? "") })}
    </div>
    <div class="prompt-actions">
      <button id="wizClose" class="primary">${t("wizard.close")}</button>
    </div>`;
  $("wizardPanel").classList.remove("hidden");
  $("wizClose").onclick = () => {
    $("wizardPanel").classList.add("hidden");
    S.env.firstRun = false;
    api("/api/config", { wizardDone: true }).catch(() => {});
  };
  $("wizardBody").querySelectorAll("[data-wiz]").forEach((b) => {
    b.onclick = () => {
      $("wizardPanel").classList.add("hidden");
      if (b.dataset.wiz === "settings") showSettings();
      if (b.dataset.wiz === "sync") openSync();
    };
  });
}

/* ============================ 事件绑定 ============================ */
function bindEvents() {
  // 添加题目
  $("addBtn").onclick = () => {
    const v = $("pidInput").value.trim();
    const active = $("suggest").querySelector(".item.active") ?? $("suggest").querySelector(".item");
    if (!$("suggest").classList.contains("hidden") && active && !/^[A-Za-z]+\d/.test(v)) {
      $("pidInput").value = active.dataset.pid;
      hideSuggest();
      addProblemByPid(active.dataset.pid);
    } else addProblemByPid(v);
  };
  $("pidInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const active = $("suggest").querySelector(".item.active") ?? $("suggest").querySelector(".item");
      if (!$("suggest").classList.contains("hidden") && active) {
        $("pidInput").value = active.dataset.pid;
        hideSuggest();
        addProblemByPid(active.dataset.pid);
      } else addProblemByPid($("pidInput").value);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...$("suggest").querySelectorAll(".item")];
      if (!items.length) return;
      e.preventDefault();
      const cur = items.findIndex((x) => x.classList.contains("active"));
      const next = e.key === "ArrowDown" ? Math.min(items.length - 1, cur + 1) : Math.max(0, cur - 1);
      items.forEach((x) => x.classList.remove("active"));
      items[next].classList.add("active");
      items[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Escape") hideSuggest();
  });
  $("pidInput").addEventListener("input", (e) => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => fetchSuggest(e.target.value), 320);
  });
  $("pidInput").addEventListener("blur", () => setTimeout(hideSuggest, 200));

  // 文件夹
  $("addFolder").onclick = async () => {
    const f = newFolder();
    withUndo(t("undo.newFolder"), () => S.doc.tree.push(f));
    const name = await askText(t("prompt.newFolder"), f.name);
    if (name != null) { f.name = name.trim() || t("folder.unnamed"); markDirty(); renderOutline(); }
  };
  $("addSubFolder").onclick = async () => {
    const e = findEntry(S.currentId);
    const parent = e?.node.kind === "folder" ? e.node : (e?.parent ?? null);
    const f = newFolder();
    withUndo(t("undo.newSubFolder"), () => {
      if (parent) { parent.children = parent.children ?? []; parent.children.unshift(f); parent.collapsed = false; }
      else S.doc.tree.push(f);
    });
    const name = await askText(t("prompt.newSubFolder"), f.name);
    if (name != null) { f.name = name.trim() || t("folder.unnamed"); markDirty(); renderOutline(); }
  };

  // 批量
  $("batchDelete").onclick = () => deleteNodes(topLevelSelection());
  $("batchMove").onclick = batchMove;
  $("batchAc").onclick = () => batchStatus("ac");
  $("batchTodo").onclick = () => batchStatus("todo");
  $("batchClear").onclick = clearSelection;
  $("toastUndo").onclick = () => { $("toast").classList.add("hidden"); undo(); };

  // 搜索筛选
  $("searchInput").addEventListener("input", debounce((e) => {
    S.filters.q = e.target.value.trim();
    renderOutline();
  }, 180));
  $("clearFilters").onclick = () => { clearAllFilters(); renderOutline(); };

  // 题目操作
  $("refreshProblem").onclick = async () => {
    const p = currentProblem();
    if (!p) return;
    try {
      const { problem } = await api("/api/problem/fetch", { pid: p.pid });
      Object.assign(p, problem, { id: p.id, status: p.status, code: p.code, note: p.note, tests: p.tests });
      markDirty();
      renderProblem();
      renderOutline();
      toast(t("toast.refetched", { pid: p.pid }));
    } catch (e) { toast(t("toast.refetchFailed", { message: e.message }), true); }
  };
  $("shareProblem").onclick = shareCurrent;
  $("deleteProblem").onclick = () => {
    const e = findEntry(S.currentId);
    if (e) deleteNodes([e.node]);
  };
  $("statusSelect").onchange = (e) => {
    const p = currentProblem();
    if (!p) return;
    p.status = e.target.value;
    markDirty();
    renderOutline();
    renderProblem();
  };

  // 运行
  $("runBtn").onclick = () => runCode(false);
  $("judgeBtn").onclick = () => runCode(true);
  $("stopBtn").onclick = async () => {
    try { await api("/api/kill", {}); toast(t("toast.killRequested")); }
    catch (e) { toast(t("toast.stopFailed", { message: e.message }), true); }
  };
  $("fillSample").onclick = () => {
    const p = currentProblem();
    const s = p?.samples?.[0];
    if (!s) return toast(t("toast.noSamples"), true);
    $("stdin").value = s.input ?? "";
    $("expected").value = s.output ?? "";
    switchTab("io");
  };
  $("formatBtn").onclick = formatCurrent;

  // 标签页
  $("tabs").onclick = (e) => {
    const b = e.target.closest(".tab");
    if (b) switchTab(b.dataset.tab);
  };
  $("addTest").onclick = () => {
    const p = currentProblem();
    if (!p) return toast(t("toast.pickProblemFirst"), true);
    pushUndo(t("undo.newTest"));
    p.tests = p.tests ?? [];
    p.tests.push({ id: uid("t"), name: "", input: $("stdin").value, output: $("expected").value });
    markDirty();
    renderTests();
    switchTab("tests");
  };
  $("runAllTests").onclick = runAllTests;

  // 界面配色
  $("themeSelect").onchange = async (e) => {
    applyTheme(e.target.value);
    api("/api/config", { uiTheme: e.target.value }).catch(() => {});
  };

  // 界面语言：切完存盘并重载，让所有已渲染的内容整体换成新语言
  renderLangSelect($("langSelect"), (lang) => {
    api("/api/config", { uiLang: lang }).catch(() => {});
    location.reload();
  });

  // 档案
  $("profileSelect").onchange = (e) => switchProfile(e.target.value);

  // 面板
  $("syncBtn").onclick = openSync;
  $("syncFetch").onclick = doSyncFetch;
  $("syncUid").addEventListener("keydown", (e) => { if (e.key === "Enter") doSyncFetch(); });
  $("pdfBtn").onclick = openPdf;
  $("pdfGo").onclick = doExportPdf;
  $("statsBtn").onclick = showStats;
  $("mdBtn").onclick = showMarkdown;
  $("settingsBtn").onclick = showSettings;

  $("exportBtn").onclick = (e) => { e.stopPropagation(); $("exportMenu").classList.toggle("hidden"); };
  document.addEventListener("click", (e) => {
    if (!$("exportMenu").contains(e.target) && e.target !== $("exportBtn")) $("exportMenu").classList.add("hidden");
  });
  $("exportMenu").onclick = async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    $("exportMenu").classList.add("hidden");
    await saveNow();
    if (act === "md") {
      const { markdown } = await api("/api/markdown");
      download("notebook.md", markdown, "text/markdown;charset=utf-8");
    } else if (act === "json") {
      download("notebook.json", JSON.stringify(S.doc, null, 2), "application/json");
    } else if (act === "copy-md") {
      const { markdown } = await api("/api/markdown");
      await navigator.clipboard.writeText(markdown);
      toast(t("toast.markdownCopied"));
    } else if (act === "backup") {
      const r = await api("/api/backup", {});
      toast(t("toast.backedUp", { file: r.file }), false, 4000);
    } else if (act === "share") {
      shareCurrent();
    } else if (act === "import-card") {
      importCardFile();
    } else if (act === "import-md") {
      pickFile(".md,.markdown,.txt", async (text) => {
        if (!confirm(t("confirm.importMarkdown"))) return;
        const r = await api("/api/import", { markdown: text, merge: false });
        S.doc = r.doc;
        S.currentId = null;
        $("docTitle").value = S.doc.title;
        renderOutline();
        renderProblem();
        toast(t("toast.importDone", { n: r.count }));
      });
    } else if (act === "import-json") {
      pickFile(".json", async (text) => {
        const doc = JSON.parse(text);
        if (!confirm(t("confirm.importJson"))) return;
        S.doc = doc;
        S.currentId = null;
        $("docTitle").value = doc.title ?? t("doc.defaultTitle");
        await saveNow();
        renderOutline();
        renderProblem();
        toast(t("toast.importDoneShort"));
      });
    }
  };

  $("docTitle").oninput = debounce(() => markDirty(), 400);
  $("copyMd").onclick = async () => {
    await navigator.clipboard.writeText($("mdBody").textContent);
    toast(t("toast.copied"));
  };
  $("promptOk").onclick = () => closePrompt($("promptInput").value);
  $("promptInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") closePrompt($("promptInput").value);
    if (e.key === "Escape") closePrompt(null);
  });
  document.querySelectorAll("[data-close]").forEach((b) => {
    b.onclick = () => {
      b.closest(".modal").classList.add("hidden");
      if (b.closest("#promptPanel")) closePrompt(null);
    };
  });
  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "");
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveNow().then(() => toast(t("toast.saved")));
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && e.target === $("outlineScroll")) {
      e.preventDefault();
      for (const r of document.querySelectorAll("#outline .row")) S.selected.add(r.dataset.id);
      renderOutline();
    }
    if (e.key === "Delete" && !typing && S.selected.size) {
      e.preventDefault();
      deleteNodes(topLevelSelection());
    }
    if (e.key === "Escape") {
      document.querySelectorAll(".modal:not(.hidden)").forEach((m) => m.classList.add("hidden"));
      $("exportMenu").classList.add("hidden");
    }
  });

  setupSplitters();
  setupMarquee();
  bindRootDrop();
  window.addEventListener("beforeunload", (e) => {
    if ($("saveState").classList.contains("dirty")) { saveNow(); e.preventDefault(); e.returnValue = ""; }
  });
}

function setupSplitters() {
  let dragging = null;
  document.querySelectorAll(".splitter").forEach((sp) => {
    sp.addEventListener("mousedown", (e) => {
      dragging = sp;
      sp.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    if (dragging.dataset.split === "outline") {
      $("paneOutline").style.width = `${Math.max(190, Math.min(560, e.clientX))}px`;
    } else {
      const left = $("paneOutline").getBoundingClientRect().right + 5;
      $("paneProblem").style.width = `${Math.max(260, Math.min(window.innerWidth - left - 330, e.clientX - left))}px`;
    }
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging.classList.remove("dragging");
    dragging = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    paintEditor();
  });
}

/* ============================ 搜索联想 / 添加 ============================ */
let suggestTimer = null;
async function fetchSuggest(q) {
  const kw = q.trim();
  if (kw.length < 1) return hideSuggest();
  try {
    const { list } = await api("/api/problem/search", { keyword: kw });
    const box = $("suggest");
    if (!list.length) return hideSuggest();
    box.innerHTML = list.slice(0, 12).map((x) => {
      const d = DIFF[x.difficulty] ?? DIFF[0];
      return `<div class="item" data-pid="${esc(x.pid)}">
        <span class="pid" style="color:${d.color}">${esc(x.pid)}</span>
        <span class="t">${esc(x.title)}</span>
        <span class="badge" style="font-size:10.5px;color:${d.color}">${esc(d.name)}</span></div>`;
    }).join("");
    box.classList.remove("hidden");
    box.querySelectorAll(".item").forEach((el) => {
      el.onmousedown = (e) => {
        e.preventDefault();
        $("pidInput").value = el.dataset.pid;
        hideSuggest();
        addProblemByPid(el.dataset.pid);
      };
    });
  } catch { hideSuggest(); }
}
function hideSuggest() { $("suggest").classList.add("hidden"); }

async function addProblemByPid(pidRaw) {
  const pid = String(pidRaw ?? "").trim();
  if (!pid) return;
  $("addBtn").disabled = true;
  $("addBtn").textContent = t("add.fetching");
  try {
    const { problem } = await api("/api/problem/fetch", { pid });
    const dup = flattenProblems().find((i) => i.pid === problem.pid);
    if (dup) { toast(t("toast.duplicate", { pid: problem.pid })); selectNode(dup.id); return; }
    const item = {
      id: uid("p"), kind: "problem", ...problem,
      status: "todo", code: "", note: "", tests: [], addedAt: Date.now(),
    };
    pushUndo(t("undo.addProblem", { pid: problem.pid }));
    const e = findEntry(S.currentId);
    if (e?.node.kind === "folder") {
      e.node.children = e.node.children ?? [];
      e.node.children.unshift(item);
      e.node.collapsed = false;
    } else if (e?.parent) {
      const list = e.parent.children;
      list.splice(list.findIndex((n) => n.id === e.node.id) + 1, 0, item);
    } else S.doc.tree.push(item);
    clearAllFilters();
    markDirty();
    $("pidInput").value = "";
    hideSuggest();
    renderOutline();
    selectNode(item.id);
    toast(t("toast.added", { pid: problem.pid, title: problem.title }));
  } catch (e) {
    toast(t("toast.fetchFailed", { message: e.message }), true, 4200);
  } finally {
    $("addBtn").disabled = false;
    $("addBtn").textContent = t("add.button");
  }
}

/* ============================ 启动 ============================ */
async function boot() {
  editor.ta = $("code");
  editor.hl = $("hlCode");
  editor.gutter = $("gutterInner");
  setupEditorKeys();
  bindEvents();
  applyI18n();   // 先把静态文案刷成当前语言（拿不到后端数据时也要正常显示）

  try {
    const state = await api("/api/state");
    S.doc = state.doc;
    S.profiles = state.profiles;
    S.env = { ...state.env, paths: state.paths };
    S.themes = state.themes ?? [];
    S.styles = state.styles ?? [];
    // 语言：服务端配置是权威。若和首屏用的（localStorage）不一致，说明在别处改过，
    // 重新加载一次让所有渲染都走新语言；setLang 已把新值写进 localStorage，不会来回重载。
    const cfgLang = S.env.uiLang || "zh-CN";
    if (cfgLang !== getLang()) { setLang(cfgLang); location.reload(); return; }
    applyI18n();
    $("docTitle").value = S.doc.title ?? t("doc.defaultTitle");
    applyTheme(S.env.uiTheme || "dark");
    renderProfiles();
  } catch (e) {
    toast(t("toast.loadFailed", { message: e.message }), true);
  }

  renderOutline();
  const first = flattenProblems()[0];
  if (first) selectNode(first.id);
  else renderProblem();
  updateSaveState(false);
  switchTab("io");

  // 首次运行 / 环境不完整时给向导
  const e = S.env ?? {};
  if (e.firstRun || !e.hasGpp || !e.hasBrowser) {
    setTimeout(showWizard, 400);
  }
}

document.addEventListener("DOMContentLoaded", boot);
