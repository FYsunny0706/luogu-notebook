// 灌入演示数据（文件夹树版），仅用于 UI 测试
const B = "http://127.0.0.1:8765";
async function api(path, body) {
  const r = await fetch(B + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j;
}
const pids = ["P1001", "P1048", "P3374", "P3368", "P1909", "P1216"];
const problems = [];
for (const pid of pids) {
  const { problem } = await api("/api/problem/fetch", { pid });
  problems.push(problem);
  console.log("抓取", problem.pid, problem.title, "难度", problem.difficulty);
}
const P = (p, extra = {}) => ({
  id: "p_" + p.pid, kind: "problem", ...p,
  status: "todo", code: "", note: "", addedAt: Date.now(), ...extra,
});
const codeA = `#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    long long a, b;\n    cin >> a >> b;\n    cout << a + b << endl;\n    return 0;\n}`;
const codeB = `#include <bits/stdc++.h>\nusing namespace std;\nconst int N = 500005;\nint n, m;\nlong long tr[N];\ninline int lowbit(int x) { return x & -x; }\nvoid add(int i, long long v) { for (; i <= n; i += lowbit(i)) tr[i] += v; }\nlong long qry(int i) { long long s = 0; for (; i; i -= lowbit(i)) s += tr[i]; return s; }\nint main() {\n    scanf("%d%d", &n, &m);\n    for (int i = 1; i <= n; i++) { long long x; scanf("%lld", &x); add(i, x); }\n    while (m--) {\n        int op, x, y; scanf("%d%d%d", &op, &x, &y);\n        if (op == 1) add(x, y);\n        else printf("%lld\\n", qry(y) - qry(x - 1));\n    }\n    return 0;\n}`;

const doc = {
  version: 2,
  title: "我的洛谷刷题本",
  tree: [
    {
      id: "f_base", kind: "folder", name: "基础算法", collapsed: false, children: [
        {
          id: "f_sim", kind: "folder", name: "模拟与枚举", collapsed: false, children: [
            P(problems[0], { status: "ac", code: codeA, note: "注意 a+b 会爆 int，用 long long。" }),
            P(problems[4], { status: "review", note: "买铅笔：三种包装取最小花费。" }),
          ],
        },
        {
          id: "f_dp", kind: "folder", name: "动态规划", collapsed: false, children: [
            P(problems[1], { status: "stuck", note: "01 背包，复习滚动数组写法。" }),
            P(problems[5], { status: "todo", note: "数字三角形。" }),
          ],
        },
      ],
    },
    {
      id: "f_ds", kind: "folder", name: "数据结构", collapsed: false, children: [
        {
          id: "f_bit", kind: "folder", name: "树状数组", collapsed: false, children: [
            P(problems[2], { status: "ac", code: codeB, note: "单点修改 + 区间查询。" }),
            P(problems[3], { status: "todo", note: "差分树状数组还没想明白。" }),
          ],
        },
      ],
    },
  ],
};
await api("/api/save", { doc });
const count = (n) => (n.children ?? []).reduce((a, c) => a + (c.kind === "problem" ? 1 : count(c)), 0);
console.log("已写入测试数据：文件夹", doc.tree.length, "个顶层，题目", count({ children: doc.tree }), "道");
