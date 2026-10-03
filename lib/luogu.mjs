// 洛谷题目抓取：cookie jar 解 C3VK 重定向 -> 解析 lentille-context JSON -> 清洗题面
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DIFFICULTY = {
  0: { name: "暂无评定", short: "暂无", color: "#bfbfbf" },
  1: { name: "入门", short: "入门", color: "#fe4c61" },
  2: { name: "普及-", short: "普及-", color: "#f39c11" },
  3: { name: "普及/提高-", short: "普及", color: "#ffc116" },
  4: { name: "普及+/提高", short: "提高", color: "#52c41a" },
  5: { name: "提高+/省选-", short: "省选-", color: "#3498db" },
  6: { name: "省选/NOI-", short: "省选", color: "#9d3dcf" },
  7: { name: "NOI/NOI+/CTSC", short: "NOI", color: "#0e1d69" },
};

const jar = new Map();
let tagCache = null;
let tagCacheAt = 0;

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorb(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

/** 需要手动跟重定向：洛谷先 302 下发 C3VK，不带 cookie 回来就会死循环 */
async function luoguFetch(url, { headers = {}, hops = 6 } = {}) {
  let cur = url;
  for (let hop = 0; hop <= hops; hop++) {
    const h = { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9", ...headers };
    if (jar.size) h.cookie = cookieHeader();
    const res = await fetch(cur, { redirect: "manual", headers: h });
    absorb(res);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      cur = new URL(loc, cur).href;
      continue;
    }
    return res;
  }
  throw new Error("洛谷重定向次数过多，可能是反爬拦截，稍后重试");
}

function unescapeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 新版洛谷把整页数据塞在 <script id="lentille-context" type="application/json"> 里 */
function extractLentille(html) {
  const marker = html.indexOf('id="lentille-context"');
  if (marker < 0) return null;
  const start = html.indexOf(">", marker) + 1;
  const end = html.indexOf("</script>", start);
  if (start <= 0 || end < 0) return null;
  const raw = html.slice(start, end).trim();
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(unescapeEntities(raw));
    } catch {
      return null;
    }
  }
}

export async function fetchTagDict({ maxAgeMs = 24 * 3600 * 1000 } = {}) {
  if (tagCache && Date.now() - tagCacheAt < maxAgeMs) return tagCache;
  const res = await luoguFetch("https://www.luogu.com.cn/_lfe/tags");
  if (!res.ok) throw new Error(`标签字典拉取失败 HTTP ${res.status}`);
  const json = await res.json();
  const map = {};
  for (const t of json.tags ?? []) map[t.id] = { name: t.name, type: t.type, parent: t.parent };
  tagCache = map;
  tagCacheAt = Date.now();
  return map;
}

export function normalizePid(input) {
  let s = String(input ?? "").trim();
  const m = s.match(/luogu\.com\.cn\/problem\/([A-Za-z0-9_-]+)/);
  if (m) s = m[1];
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return s;
}

function normalizeSamples(p) {
  const out = [];
  const raw = p?.samples;
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (Array.isArray(s)) out.push({ input: String(s[0] ?? ""), output: String(s[1] ?? "") });
      else if (s && typeof s === "object") {
        out.push({
          input: String(s.input ?? s.in ?? s[0] ?? ""),
          output: String(s.output ?? s.out ?? s[1] ?? ""),
        });
      }
    }
  }
  // 有些题目样例只存在于题面 <pre> 块里，兜底抽取
  if (!out.length) {
    const desc = p?.content?.description ?? "";
    const pres = [...desc.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
    for (let i = 0; i + 1 < pres.length; i += 2) {
      out.push({ input: stripTags(pres[i]).trimEnd(), output: stripTags(pres[i + 1]).trimEnd() });
    }
  }
  return out.filter((s) => s.input || s.output);
}

function stripTags(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

/** 删掉情景/广告/图片，只留题面干货，节省版面（题目背景默认整段丢弃） */
export function stripStory(text, { keepBackground = false } = {}) {
  if (!text) return "";
  let s = String(text);
  // 广告与“各种语言的程序范例”之后的都属于噪声
  s = s.split(/\*\*广告\*\*|【广告】|洛谷出品的算法教材/)[0];
  s = s.split(/本题各种语言的程序范例|各种语言的程序范例/)[0];
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  s = s.replace(/<img[^>]*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(?:p|div|span|strong|em|code|pre|blockquote|ul|ol|li|h[1-6])\b[^>]*>/gi, "");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/^\s+|\s+$/g, "");
  if (!keepBackground) s = s.replace(/\n*-{3,}\n*$/g, "");
  return s;
}

/** 数据范围通常写在“说明/提示”里，单独摘出来给 UI 高亮 */
export function extractDataRange(hint) {
  if (!hint) return "";
  const blocks = hint.split(/\n{2,}/);
  const hit = blocks.filter((b) => /数据范围|数据规模|范围|约定|subtask|Subtask/i.test(b));
  return hit.length ? hit.join("\n\n") : "";
}

// 情景故事的强特征：对白引号、人名角色、叙事转折
const STORY_HINT = /(有一天|从前|很久|传说|故事|梦想|孩子|小朋友|老师|于是|决定|告诉|问道|回答说|据说|听说|邀请|你能|如果你是|请你帮|「|」|“|”)/;
// 正经题面的强特征（故意收得很紧，宁可漏判情景，也不要把题目要求藏起来）
const TASK_HINT = /(输入格式|输出格式|数据范围|样例|第一行|第二行|第三行|给定|保证|包含[^。]{0,8}个?整数|输出一行|输入一行|你需要|请求出|试求|多组数据|数据保证)/;

/**
 * 把题面开头的情景段落切出来。
 * 洛谷很多题（NOIP 普及组尤甚）整段描述都是故事，真正的要求可能就藏在故事里，
 * 所以这里只负责「分离」，不负责「删除」——UI 会把情景折叠起来，信息不丢。
 */
export function splitNarrative(text) {
  const src = String(text ?? "");
  if (!src) return { story: "", body: "" };
  const paras = src.split(/\n{2,}/);
  const isStory = (p) => {
    const plain = p.replace(/[#*`>]/g, " ").trim();
    if (plain.length < 10) return false;
    return STORY_HINT.test(plain) && !TASK_HINT.test(plain);
  };
  let cut = 0;
  for (let i = 0; i < paras.length; i++) {
    const plain = paras[i].replace(/[#*`>]/g, " ").trim();
    if (plain.length < 10) { cut = i + 1; continue; } // 标题、短过渡句跟着情景走
    if (isStory(paras[i])) { cut = i + 1; continue; }
    break;
  }
  if (cut === 0) return { story: "", body: src };
  if (cut >= paras.length) {
    // 整段都是情景：只有单段时不敢切（故事和要求常常写在同一段里）
    if (paras.length < 2) return { story: "", body: src };
    return { story: src, body: "" };
  }
  const story = paras.slice(0, cut).join("\n\n");
  if (story.length < 20) return { story: "", body: src };
  return { story, body: paras.slice(cut).join("\n\n") };
}

export async function fetchProblem(input, { keepBackground = true } = {}) {
  const pid = normalizePid(input);
  if (!pid) throw new Error("题号为空");
  const res = await luoguFetch(`https://www.luogu.com.cn/problem/${encodeURIComponent(pid)}`);
  if (res.status === 404) throw new Error(`洛谷上没有找到题目 ${pid}`);
  if (!res.ok) throw new Error(`洛谷返回 HTTP ${res.status}`);
  const html = await res.text();
  const ctx = extractLentille(html);
  if (!ctx) throw new Error("页面结构解析失败（洛谷可能改版或触发了人机验证）");
  if (ctx.status && ctx.status !== 200) throw new Error(`洛谷接口状态 ${ctx.status}`);

  const data = ctx.data ?? {};
  const p = data.problem;
  if (!p) throw new Error(`没有取到题目 ${pid} 的数据（可能是私有题目或权限不足）`);

  // 外文题（CF/AT）有时正文在 translations 里
  let content = p.content ?? {};
  if (!content.description && Array.isArray(data.translations) && data.translations.length) {
    content = data.translations[0].content ?? content;
  }

  let tagDict = {};
  try {
    tagDict = await fetchTagDict();
  } catch {
    /* 标签字典拉不到不影响主流程 */
  }
  const tagIds = Array.isArray(p.tags) ? p.tags : [];
  const tagNames = tagIds.map((id) => tagDict[id]?.name).filter(Boolean);
  const difficulty = typeof p.difficulty === "number" ? p.difficulty : 0;

  const hint = stripStory(content.hint ?? "", { keepBackground });
  const timeLimit = Array.isArray(p.limits?.time) ? Math.max(...p.limits.time) : 1000;
  const memoryLimit = Array.isArray(p.limits?.memory) ? Math.max(...p.limits.memory) : 262144;

  // 情景分离：题面开头的故事挪到 background，默认折叠起来省地方
  const explicitBg = keepBackground ? stripStory(content.background ?? "", { keepBackground: true }) : "";
  const rawDesc = stripStory(content.description ?? "");
  const { story, body } = keepBackground ? splitNarrative(rawDesc) : { story: "", body: rawDesc };
  const description = body;
  const background = [explicitBg, story].filter((x) => x && x.trim()).join("\n\n");

  return {
    pid: p.pid ?? pid,
    title: (content.name || p.name || pid).trim(),
    difficulty,
    difficultyName: DIFFICULTY[difficulty]?.name ?? "暂无评定",
    difficultyColor: DIFFICULTY[difficulty]?.color ?? "#bfbfbf",
    tags: tagIds,
    tagNames: tagNames.length ? tagNames : tagIds.map(String),
    background,
    storyLength: story.length,
    description,
    formatI: stripStory(content.formatI ?? ""),
    formatO: stripStory(content.formatO ?? ""),
    hint,
    dataRange: extractDataRange(hint),
    samples: normalizeSamples(p),
    timeLimit,
    memoryLimit,
    totalSubmit: p.totalSubmit ?? 0,
    totalAccepted: p.totalAccepted ?? 0,
    url: `https://www.luogu.com.cn/problem/${p.pid ?? pid}`,
  };
}

/** 洛谷返回的载荷有两种形态：纯 JSON，或整页 HTML 里嵌的 lentille-context */
function parsePayload(text) {
  try {
    const j = JSON.parse(text);
    return j.currentData ?? j;
  } catch {
    const ctx = extractLentille(text);
    if (!ctx) return null;
    if (ctx.status && ctx.status !== 200) {
      const err = ctx.data?.errorMessage ?? ctx.data?.errorType ?? `洛谷返回状态 ${ctx.status}`;
      throw new Error(err);
    }
    return ctx.data ?? null;
  }
}

/** 按题号或题名搜索题目，给「添加」输入框做联想 */
export async function searchProblems(keyword, page = 1) {
  const url = `https://www.luogu.com.cn/problem/list?keyword=${encodeURIComponent(keyword)}&page=${page}&type=&difficulty=&_contentOnly=1`;
  const res = await luoguFetch(url, { headers: { "x-luogu-type": "content-only" } });
  if (!res.ok) throw new Error(`洛谷返回 HTTP ${res.status}`);
  const data = parsePayload(await res.text());
  const list = data?.problems?.result ?? [];
  return list.map((x) => ({
    pid: x.pid,
    title: x.name ?? x.title ?? "",
    difficulty: typeof x.difficulty === "number" ? x.difficulty : 0,
    accepted: x.totalAccepted ?? 0,
    submitted: x.totalSubmit ?? 0,
  }));
}

/**
 * 拉取某个用户的公开练习数据（不需要登录）。
 * 返回 { user, passed[], submitted[] }，元素形如 { pid, name, difficulty, type }
 */
export async function fetchUserPractice(uid) {
  const id = String(uid ?? "").trim().replace(/[^0-9]/g, "");
  if (!id) throw new Error("请填写洛谷用户编号（数字 UID）");
  const res = await luoguFetch(`https://www.luogu.com.cn/user/${id}/practice?_contentOnly=1`, {
    headers: { "x-luogu-type": "content-only" },
  });
  const text = await res.text();
  let data = null;
  try {
    data = parsePayload(text);
  } catch (e) {
    throw new Error(e.message);
  }
  if (!data) throw new Error("解析练习数据失败，洛谷可能改版了");
  if (data.errorType) throw new Error(data.errorMessage ?? data.errorType);
  if (!data.user) {
    throw new Error(res.status === 403
      ? "该用户把练习数据设为私密了，无法同步"
      : `没有取到用户 ${id} 的练习数据（HTTP ${res.status}）`);
  }
  const norm = (arr) => (Array.isArray(arr) ? arr : []).map((x) => ({
    pid: x.pid,
    title: x.name ?? x.title ?? "",
    difficulty: typeof x.difficulty === "number" ? x.difficulty : 0,
    type: x.type ?? "",
  }));
  return {
    user: { uid: data.user.uid, name: data.user.name, color: data.user.color ?? "" },
    passed: norm(data.passed),
    submitted: norm(data.submitted),
  };
}

export { DIFFICULTY };
