// 打印页几何自检：不依赖浏览器，直接检查 buildPrintHtml 产出的 CSS/结构是否满足「背景铺满 + 每页有留白」
//
// 背景为什么必须 @page margin:0：
//   Chrome 打印时会把每页内容裁剪到「内容区」。@page 留白不属于内容区，
//   所以根元素背景、position:fixed 全出血层都会被裁掉，四周永远一圈白边。
//   把边距设成 0，内容区 == 整张纸，背景才能真正铺满；
//   视觉留白改由「body 左右内边距 + 各区块自己的上内边距」提供（内边距跟着元素走，分页不会丢）。
import { buildPrintHtml } from "../lib/pdf.mjs";
import { load } from "../lib/store.mjs";

let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}${extra ? "  — " + extra : ""}`);
  else { fail++; console.log(`  ✗ ${name}${extra ? "  — " + extra : ""}`); }
};

const doc = load();
const rawHtml = await buildPrintHtml({ doc, theme: "darkcode", scope: "all", twoColumn: true, includeCode: true, includeNote: true });
// 断言前先剥掉 CSS 注释，免得注释里提到的写法把自己判失败
const html = rawHtml.replace(/\/\*[\s\S]*?\*\//g, "");

console.log("=== 1. @page 必须零边距（背景能否铺满的关键）===");
const pageRule = /@page\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
check("存在 @page 规则", Boolean(pageRule));
check("@page margin 为 0", /margin\s*:\s*0/.test(pageRule), pageRule.trim().replace(/\s+/g, " "));
check("没有残留的 position:fixed 全出血层（它会被裁掉，是无效方案）", !/position\s*:\s*fixed/.test(html));

console.log("\n=== 2. 视觉页边距由元素内边距提供 ===");
const bodyRule = /\nbody\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
check("body 宽度固定为 A4 宽 210mm（保证屏幕量高 == 打印排版）", /width\s*:\s*210mm/.test(bodyRule), bodyRule.trim().replace(/\s+/g, " "));
check("body 左右内边距 9mm", /padding\s*:\s*0\s+9mm/.test(bodyRule));
check("定义了 --page-gap", /--page-gap\s*:\s*11mm/.test(html));
const h1 = /\nh1\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
const h2 = /\nh2\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
const pb = /\.problem\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
check("h1 带上留白", /padding-top\s*:\s*var\(--page-gap\)/.test(h1));
check("h2 带上留白", /padding-top\s*:\s*var\(--page-gap\)/.test(h2));
check("每个 .problem 都带上留白（含第一个，防止被推到第 2 页时贴边）", /padding-top\s*:\s*var\(--page-gap\)/.test(pb), pb.trim().replace(/\s+/g, " "));
check("不存在 .problem:first-of-type{padding-top:0} 这种会让第 2 页贴边的规则", !/\.problem:first-of-type\s*\{[^}]*padding-top\s*:\s*0/.test(html));

console.log("\n=== 3. 自动压缩只作用在内容层，不缩小页边距 ===");
check("存在 .pinner", /\.pinner\s*\{/.test(html));
check("压缩脚本量的是 .problem .pinner", /querySelectorAll\('\.problem \.pinner'\)/.test(html));
const budget = /var PAGE_PX = (\d+)/.exec(html);
if (budget) {
  const px = Number(budget[1]);
  const pageH = 297 * 96 / 25.4;          // A4 高 ≈ 1122.5px
  const usable = pageH - 2 * 11 * 96 / 25.4;  // 去掉上下各 11mm ≈ 1039px
  check("压缩上限与「页高减上下留白」一致", px <= usable && px > usable - 20, `PAGE_PX=${px}，理论可用 ${usable.toFixed(0)}px`);
} else check("脚本里有 PAGE_PX", false);

console.log("\n=== 4. 结构与分页 ===");
const problems = (html.match(/<section class="problem">/g) ?? []).length;
const inners = (html.match(/<div class="pinner">/g) ?? []).length;
check("每道题都有 .pinner 包一层", problems > 0 && problems === inners, `${problems} 题 / ${inners} 个 pinner`);
check("题目块设了 break-inside:avoid", /break-inside\s*:\s*avoid/.test(pb));
check("html/body 背景色跟着主题走", /background:\s*var\(--page-bg\)/.test(html));
check("强制打印背景色", /print-color-adjust:\s*exact/.test(html));

console.log(fail === 0 ? "\n打印页几何自检全部通过 ✅" : `\n有 ${fail} 项失败 ❌`);
process.exit(fail ? 1 : 0);
