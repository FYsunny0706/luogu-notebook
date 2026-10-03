// 检查 PDF 背景是否铺满整页（有没有白边）
// 做法：解析页面树找到每个真正的页面对象 → 取其内容流 → 解压 → 把填充矩形按 CTM 换算回页面坐标(pt)
//       → 看有没有一个矩形盖住整页
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

/** 检查 PDF 每一页的背景是否铺满整页（返回 { ok, pages:[{index, full, rect}] } ） */
export function checkBleed(file) {
  const buf = fs.readFileSync(file);
  const raw = buf.toString("latin1");
  const box = /\/MediaBox\s*\[([^\]]+)\]/.exec(raw);
  const [, , W, H] = box ? box[1].trim().split(/\s+/).map(Number) : [];
  if (!W) return { ok: false, error: "解析不出 MediaBox", pages: [] };

  const objects = new Map();
  for (const m of raw.matchAll(/(\d+)\s+0\s+obj\b/g)) {
    const num = Number(m[1]);
    const end = raw.indexOf("endobj", m.index);
    objects.set(num, { from: m.index + m[0].length, to: end < 0 ? raw.length : end });
  }
  const objText = (num) => (objects.has(num) ? raw.slice(objects.get(num).from, objects.get(num).to) : "");
  const objStream = (num) => {
    const o = objects.get(num);
    if (!o) return null;
    const text = raw.slice(o.from, o.to);
    const si = text.indexOf("stream");
    if (si < 0) return null;
    let s = si + 6;
    if (text[s] === "\r") s++;
    if (text[s] === "\n") s++;
    const e = text.indexOf("endstream", s);
    const chunk = buf.subarray(o.from + s, o.from + (e < 0 ? text.length : e));
    try { return zlib.inflateSync(chunk).toString("latin1"); } catch { return chunk.toString("latin1"); }
  };

  const pageNums = [];
  for (const [num, o] of objects) {
    const text = raw.slice(o.from, o.to);
    if (/\/Type\s*\/Page[^s]/.test(text)) pageNums.push(num);
  }
  const order = [...raw.matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
  const rank = (n) => { const i = order.indexOf(n); return i === -1 ? 1e9 : i; };
  pageNums.sort((a, b) => rank(a) - rank(b));

  const mul = (m, c) => [
    m[0] * c[0] + m[2] * c[1], m[1] * c[0] + m[3] * c[1],
    m[0] * c[2] + m[2] * c[3], m[1] * c[2] + m[3] * c[3],
    m[0] * c[4] + m[2] * c[5] + m[4], m[1] * c[4] + m[3] * c[5] + m[5],
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  /** 解析内容流，返回「实际画出来的」矩形。
   *  关键：必须处理裁剪（`re W n` / `re W* n`）——Chrome 会把每页内容裁到内容区，
   *  被裁掉的部分等于没画。上一版忽略裁剪，才会误报「已铺满」。 */
  function rectsOf(text) {
    const rects = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const gs = [];          // q/Q 的图形状态栈（含 clip）
    let clip = null;        // 当前裁剪矩形（页面坐标 pt），null = 无裁剪
    const tok = /([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+re\s*(W\*?\s*n|[fF])|([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+cm|(q)\b|(Q)\b/g;
    let t;
    while ((t = tok.exec(text))) {
      if (t[1] !== undefined) {
        const x = +t[1], y = +t[2], w = +t[3], h = +t[4];
        const p1 = apply(ctm, x, y), p2 = apply(ctm, x + w, y + h);
        const r = {
          x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]),
          w: Math.abs(p2[0] - p1[0]), h: Math.abs(p2[1] - p1[1]),
        };
        if (/^W/.test(t[5])) {                       // 设置裁剪
          clip = clip
            ? { x: Math.max(clip.x, r.x), y: Math.max(clip.y, r.y),
                w: Math.max(0, Math.min(clip.x + clip.w, r.x + r.w) - Math.max(clip.x, r.x)),
                h: Math.max(0, Math.min(clip.y + clip.h, r.y + r.h) - Math.max(clip.y, r.y)) }
            : r;
        } else {                                     // 填充
          const v = clip
            ? { x: Math.max(clip.x, r.x), y: Math.max(clip.y, r.y),
                w: Math.max(0, Math.min(clip.x + clip.w, r.x + r.w) - Math.max(clip.x, r.x)),
                h: Math.max(0, Math.min(clip.y + clip.h, r.y + r.h) - Math.max(clip.y, r.y)) }
            : r;
          if (v.w > 0.5 && v.h > 0.5) rects.push({ ...v, clipped: Boolean(clip) });
        }
      } else if (t[6] !== undefined) {
        ctm = mul(ctm, [+t[6], +t[7], +t[8], +t[9], +t[10], +t[11]]);
      } else if (t[12]) {
        gs.push({ ctm, clip });
      } else if (t[13]) {
        const s = gs.pop();
        if (s) { ctm = s.ctm; clip = s.clip; }
      }
    }
    return rects;
  }

  const covers = (r) => r.x <= 1.5 && r.y <= 1.5 && r.x + r.w >= W - 1.5 && r.y + r.h >= H - 1.5;
  const pages = pageNums.map((num, i) => {
    const text = objText(num);
    const contentNums = [];
    for (const r of text.matchAll(/\/Contents\s+(?:(\d+)\s+0\s+R|\[([^\]]+)\])/g)) {
      if (r[1]) contentNums.push(Number(r[1]));
      else for (const x of (r[2] ?? "").matchAll(/(\d+)\s+0\s+R/g)) contentNums.push(Number(x[1]));
    }
    const all = [];
    for (const cn of contentNums) { const s = objStream(cn); if (s) all.push(...rectsOf(s)); }
    const big = all.filter((r) => r.w * r.h > W * H * 0.3).sort((a, b) => b.w * b.h - a.w * a.h);
    const hit = big.find(covers);
    return { index: i + 1, full: Boolean(hit), rect: hit ?? big[0] ?? null };
  });
  return { ok: pages.length > 0 && pages.every((p) => p.full), pageSize: { W, H }, pages };
}

/* ---------------- 命令行 ---------------- */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  const diagnose = process.argv.includes("--allow-margin");
  if (!file) { console.log("用法: node tools/check-pdf-bg.mjs <file.pdf> [--allow-margin]"); process.exit(2); }
  const r = checkBleed(file);
  if (r.error) { console.log(r.error); process.exit(1); }
  const { W, H } = r.pageSize;
  console.log(`文件: ${path.basename(file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB  页面 ${W.toFixed(1)} x ${H.toFixed(1)} pt (A4)`);
  const mm = (v) => (v / 72 * 25.4).toFixed(1);
  console.log(`\n共 ${r.pages.length} 页：`);
  for (const p of r.pages) {
    if (p.full) { console.log(`  第 ${String(p.index).padStart(2)} 页  背景 ${p.rect.x.toFixed(1)},${p.rect.y.toFixed(1)} ${p.rect.w.toFixed(1)}x${p.rect.h.toFixed(1)}pt  铺满整页 ✓`); continue; }
    const g = p.rect;
    console.log(`  第 ${String(p.index).padStart(2)} 页  ` + (g
      ? `背景 ${g.x.toFixed(1)},${g.y.toFixed(1)} ${g.w.toFixed(1)}x${g.h.toFixed(1)}pt  白边 左${mm(g.x)} 右${mm(W - g.x - g.w)} 上${mm(H - g.y - g.h)} 下${mm(g.y)} mm ✗`
      : "没有整页大小的背景 ✗"));
  }
  if (diagnose) { console.log("\n(仅诊断)"); process.exit(0); }
  console.log(r.ok ? "\n✓ 每页背景都铺满，没有白边" : "\n✗ 存在白边");
  process.exit(r.ok ? 0 : 1);
}
