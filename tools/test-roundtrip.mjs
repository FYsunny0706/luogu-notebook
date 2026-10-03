// 往返测试：文件夹树 -> markdown -> 重新导入 -> 逐字段比对；顺带测 v1 旧数据迁移
import fs from "node:fs";
import { toMarkdown, importMarkdown, migrateDoc, walk, flattenProblems } from "../lib/store.mjs";
import { fetchProblem } from "../lib/luogu.mjs";

let fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`  ✗ ${label}\n     实际: ${JSON.stringify(actual)}\n     期望: ${JSON.stringify(expected)}`); }
  else console.log(`  ✓ ${label}`);
};

/* ---------- 1. v1 旧数据迁移 ---------- */
console.log("=== 1. 旧版（大/小标题）迁移到文件夹树 ===");
const v1 = {
  version: 1,
  title: "旧本子",
  items: [
    { id: "p0", kind: "problem", pid: "A0001", title: "标题之前的顶层题", status: "todo" },
    { id: "h1", kind: "heading", level: 1, title: "第一章 基础" },
    { id: "h2", kind: "heading", level: 2, title: "1.1 入门" },
    { id: "p1", kind: "problem", pid: "P1001", title: "A+B", status: "ac" },
    { id: "h3", kind: "heading", level: 2, title: "1.2 排序" },
    { id: "p2", kind: "problem", pid: "P1177", title: "排序", status: "todo" },
    { id: "h4", kind: "heading", level: 1, title: "第二章 图论" },
    { id: "p3", kind: "problem", pid: "P3371", title: "最短路", status: "review" },
  ],
};
const migrated = migrateDoc(v1);
check("版本号升到 3", migrated.version, 3);
check("根层节点", migrated.tree.map((n) => `${n.kind}:${n.name ?? n.pid}`),
  ["problem:A0001", "folder:第一章 基础", "folder:第二章 图论"]);
check("一级文件夹的子节点", migrated.tree[1].children.map((n) => `${n.kind}:${n.name ?? n.pid}`),
  ["folder:1.1 入门", "folder:1.2 排序"]);
check("题目挂到了对的文件夹",
  migrated.tree[1].children[0].children.map((n) => n.pid), ["P1001"]);
check("第二个小标题下的题目",
  migrated.tree[1].children[1].children.map((n) => n.pid), ["P1177"]);
check("第二章的题目直接挂在自己下面",
  migrated.tree[2].children.map((n) => n.pid), ["P3371"]);
check("旧 items 字段已移除", "items" in migrated, false);
check("迁移后题目总数不变", flattenProblems(migrated.tree).length, 4);

/* ---------- 2. 往返 ---------- */
console.log("\n=== 2. 树 -> Markdown -> 树 往返 ===");
const p1001 = await fetchProblem("P1001");
const p3374 = await fetchProblem("P3374");
const deepCode = `#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    // 反引号测试 \`\`\` 和中文注释\n    long long a, b;\n    cin >> a >> b;\n    cout << a + b << endl;\n    return 0;\n}`;

const doc = {
  version: 2,
  title: "往返测试本",
  tree: [
    {
      id: "f1", kind: "folder", name: "基础算法", collapsed: false,
      children: [
        { id: "f1a", kind: "folder", name: "模拟与枚举", collapsed: false, children: [
          { ...p1001, id: "p1", kind: "problem", status: "ac", code: deepCode, note: "注意负数。\n第二行笔记。",
            tests: [
              { id: "t1", name: "小数据", input: "1 2\n", output: "3\n" },
              { id: "t2", name: "", input: "1000000000 1000000000\n", output: "2000000000\n" },
            ],
          },
        ] },
        { id: "p2", kind: "problem", ...p3374, status: "review", code: "", note: "" },
      ],
    },
    { id: "p3", kind: "problem", ...p3374, pid: "P3368", title: "【模板】树状数组 2", status: "todo", code: "", note: "还没做" },
    {
      id: "f2", kind: "folder", name: "三级嵌套", collapsed: false,
      children: [{ id: "f2a", kind: "folder", name: "第二层", children: [
        { id: "f2b", kind: "folder", name: "第三层", children: [
          { id: "p4", kind: "problem", ...p1001, pid: "P9999", title: "深层题目", status: "stuck", code: "", note: "" },
          { id: "p5", kind: "problem", ...p3374, pid: "P8888", title: "同层第二题", status: "ac", code: "int main(){}", note: "同层" },
        ] },
      ] }],
    },
    { id: "p6", kind: "problem", ...p1001, pid: "P7777", title: "结尾根层题", status: "todo", code: "", note: "" },
  ],
};

const text = toMarkdown(doc);
fs.writeFileSync(new URL("../build/roundtrip.md", import.meta.url), text, "utf8");
console.log("导出 markdown 长度:", text.length);

const back = importMarkdown(text);
const shape = (nodes) => nodes.map((n) => n.kind === "folder"
  ? { f: n.name, c: shape(n.children ?? []) }
  : n.pid);
check("树结构完全一致", shape(back.tree), shape(doc.tree));
check("标题", back.title, doc.title);
check("题目总数", flattenProblems(back.tree).length, flattenProblems(doc.tree).length);

const orig = flattenProblems(doc.tree);
const got = flattenProblems(back.tree);
check("题号顺序", orig.map((p) => p.pid), got.map((p) => p.pid));
check("状态", orig.map((p) => p.status), got.map((p) => p.status));
check("代码逐字节一致", orig.map((p) => p.code), got.map((p) => p.code));
check("笔记", orig.map((p) => p.note), got.map((p) => p.note));
check("难度", orig.map((p) => p.difficulty), got.map((p) => p.difficulty));
check("标签", orig.map((p) => p.tagNames), got.map((p) => p.tagNames));
check("描述", orig.map((p) => p.description), got.map((p) => p.description));
check("输入格式", orig.map((p) => p.formatI), got.map((p) => p.formatI));
check("数据范围", orig.map((p) => p.hint), got.map((p) => p.hint));
check("样例", orig.map((p) => p.samples), got.map((p) => p.samples));
check("情景", orig.map((p) => p.background), got.map((p) => p.background));
check("自测数据点", orig.map((p) => (p.tests ?? []).map((t) => [t.name, t.input, t.output])),
  got.map((p) => (p.tests ?? []).map((t) => [t.name, t.input, t.output])));

/* ---------- 3. 空文档 ---------- */
console.log("\n=== 3. 边界情况 ===");
const empty = toMarkdown({ title: "空本子", tree: [] });
check("空文档导出不报错", empty.includes("空本子"), true);
check("空文档导入得到空树", importMarkdown(empty).tree.length, 0);
const onlyFolder = toMarkdown({ title: "T", tree: [{ id: "x", kind: "folder", name: "只有文件夹", children: [] }] });
check("只有文件夹也能往返", importMarkdown(onlyFolder).tree.map((n) => n.name), ["只有文件夹"]);

console.log(fail === 0 ? "\n往返与迁移测试全部通过 ✅" : `\n有 ${fail} 项不一致 ❌`);
process.exit(fail === 0 ? 0 : 1);
