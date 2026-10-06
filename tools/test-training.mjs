// 题单导入自测：题单号解析 + 公开题单拉取 + 错误处理
// 需要联网（只读洛谷公开数据）。用法：node tools/test-training.mjs [题单号]
import { fetchTraining, normalizeTrainingId } from "../lib/luogu.mjs";

const results = [];
const ok = (name, cond, extra = "") => {
  results.push(Boolean(cond));
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
};

console.log("===== 1. 题单号解析 =====");
const cases = [
  ["117", "117"],
  ["  42  ", "42"],
  ["https://www.luogu.com.cn/training/117", "117"],
  ["https://www.luogu.com.cn/training/117#problems", "117"],
  ["https://www.luogu.com.cn/training/117?foo=1", "117"],
  ["abc", ""],
  ["", ""],
  ["https://www.luogu.com.cn/problem/P1001", ""],
];
let pass = 0;
for (const [input, want] of cases) {
  const got = normalizeTrainingId(input);
  const hit = got === want;
  if (hit) pass++;
  console.log(`    ${hit ? "✓" : "✗"} ${JSON.stringify(input).padEnd(52)} → ${JSON.stringify(got)}`);
}
ok("题单号解析全部正确", pass === cases.length, `${pass}/${cases.length}`);

console.log("\n===== 2. 拉取公开题单 =====");
const id = process.argv[2] ?? "117";
try {
  const t = await fetchTraining(id);
  console.log(`    题单: ${t.name}`);
  console.log(`    题目: ${t.count} 道`);
  for (const p of t.problems.slice(0, 3)) console.log(`      ${p.pid.padEnd(7)} ${p.title.slice(0, 26)}`);
  ok("拿到题单名", Boolean(t.name), t.name);
  ok("拿到题目列表", t.count > 0, `${t.count} 道`);
  ok("每题都有 pid 和标题", t.problems.every((p) => p.pid && p.title));
  ok("难度是数字", t.problems.every((p) => typeof p.difficulty === "number"));
} catch (e) {
  ok("拉取公开题单", false, e.message);
}

console.log("\n===== 3. 错误处理（不该崩，要给能看懂的话） =====");
for (const bad of ["abc", "99999999"]) {
  try {
    await fetchTraining(bad);
    ok(`非法输入 ${bad} 应当报错`, false, "居然成功了");
  } catch (e) {
    ok(`非法输入 ${bad} 友好报错`, e.message.length > 4, e.message);
  }
}

const p = results.filter(Boolean).length;
console.log(`\n${p === results.length ? "✅" : "❌"} 题单导入自测 ${p}/${results.length}`);
process.exit(p === results.length ? 0 : 1);
