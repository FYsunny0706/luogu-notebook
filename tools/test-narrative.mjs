// 检查「情景分离」是否合理：故事进 background，正经题面留在 description
import { fetchProblem, splitNarrative } from "../lib/luogu.mjs";

console.log("=== splitNarrative 单元检查 ===");
const cases = [
  ["纯故事", "辰辰是个天资聪颖的孩子，他的梦想是成为世界上最伟大的医师。为此，他想拜附近最有威望的医师为师。\n\n如果你是辰辰，你能完成这个任务吗？"],
  ["故事+任务", "从前有座山，山里有个老和尚。「你来算算这道题吧」，他说。\n\n给定 n 个数，求它们的和。"],
  ["正经题面", "给定一个长度为 n 的序列，你需要支持区间求和。\n\n第一行包含两个整数 n, m。"],
  ["无情景", "输出两个整数 a, b 的和。"],
];
for (const [name, text] of cases) {
  const { story, body } = splitNarrative(text);
  console.log(`\n[${name}]`);
  console.log("  情景:", JSON.stringify(story.slice(0, 42)) + (story.length > 42 ? "…" : ""));
  console.log("  题面:", JSON.stringify(body.slice(0, 42)) + (body.length > 42 ? "…" : ""));
}

console.log("\n=== 真实题目检查 ===");
for (const pid of ["P1048", "P1001", "P3374", "P3368", "P1909"]) {
  try {
    const p = await fetchProblem(pid);
    const storyInDesc = p.description.includes("辰辰") || p.description.includes("孩子");
    console.log(`\n${p.pid} ${p.title}`);
    console.log(`  背景/情景 ${String(p.background.length).padStart(4)} 字 | 题面 ${String(p.description.length).padStart(4)} 字`);
    console.log(`  题面开头: ${JSON.stringify(p.description.slice(0, 54))}`);
    if (p.background) console.log(`  情景开头: ${JSON.stringify(p.background.slice(0, 40))}`);
    if (storyInDesc) console.log("  ⚠ 题面里可能仍残留故事情节");
  } catch (e) {
    console.log(`${pid} 抓取失败: ${e.message}`);
  }
}
