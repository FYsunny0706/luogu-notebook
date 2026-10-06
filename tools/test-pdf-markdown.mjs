// 打印页（导出 PDF 的中间产物）必须真的渲染过 Markdown：
// 这条链路以前因为 UMD marked 被当成 ESM 加载，静默退化成「原始 Markdown 直接输出」，
// 表现为 PDF 里列表/粗体/公式/图片全丢。用构造数据把关键点钉死。
import { buildPrintHtml } from "../lib/pdf.mjs";

const results = [];
const ok = (name, cond, extra = "") => {
  results.push(Boolean(cond));
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
};

const doc = {
  title: "自测笔记本",
  tree: [
    {
      id: "p1", kind: "problem", pid: "P9999", title: "渲染自测题",
      difficulty: 2, difficultyName: "普及-", difficultyColor: "#f39c11",
      tagNames: ["自测"], status: "todo",
      description: [
        "第一段**粗体**和一个行内公式 $a+b$。",
        "",
        "![示意图](images/P9999/abc.png)",
        "",
        "- 列表项甲",
        "- 列表项乙",
        "",
        "1. 有序项一",
        "2. 有序项二",
      ].join("\n"),
      formatI: "输入一个整数 $n$。",
      formatO: "输出答案。",
      hint: "数据范围：$1 \\le n \\le 10$。",
      note: "自己的笔记，带 `代码`。",
      samples: [{ input: "1", output: "1" }],
      code: "#include <bits/stdc++.h>\nint main(){return 0;}",
      timeLimit: 1000, memoryLimit: 256,
      url: "https://www.luogu.com.cn/problem/P9999",
    },
  ],
};

const html = await buildPrintHtml({
  doc, theme: "darkcode", scope: "all", twoColumn: true, includeCode: true, includeNote: true, lang: "zh-CN",
});

console.log("===== 打印页渲染自测 =====");
ok("marked 真的渲染出了列表", /<ul>[\s\S]*<li>/.test(html) && /<ol>[\s\S]*<li>/.test(html));
ok("粗体渲染成 <strong>", /<strong>粗体<\/strong>/.test(html));
ok("代码片段渲染成 <code>", /<code>代码<\/code>/.test(html));
ok("图片渲染成 <img>", /<img[^>]*src="\/api\/image\/P9999\/abc\.png"/.test(html));
ok("没有残留未渲染的 Markdown 图片语法", !/!\[[^\]]*\]\(/.test(html));
ok("没有残留未渲染的粗体语法", !/\*\*粗体\*\*/.test(html));
ok("没有残留未渲染的列表符号", !/^- 列表项甲/m.test(html));
ok("数学公式原样保留给 KaTeX", html.includes("$a+b$") && html.includes("$1 \\le n \\le 10$"));
ok("页面几何仍然正确（A4 / 无边距）", /@page \{ size: A4; margin: 0; \}/.test(html) && html.includes("width: 210mm"));
ok("题号标题都在", html.includes("P9999") && html.includes("渲染自测题"));

const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "✅" : "❌"} 打印页渲染自测 ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
