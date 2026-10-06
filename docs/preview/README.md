# 功能预览图

这 9 张图是程序**真实界面/真实导出结果**的截图，已上传到仓库 `docs/preview/`，README 直接引用即可。

重新生成：先起服务，再跑 `node tools/make-previews.mjs`（无头 Edge + CDP，一次出全部 9 张）。

| 文件 | 内容 | 尺寸 |
| --- | --- | --- |
| `01-overview.jpg` | 主界面总览：文件夹树 + 题面（**含抓下来的题面图片**）+ 代码编辑器 | 2200×1269 |
| `02-judge.jpg` | 本地评测：样例逐点比对、AC 判定与耗时 | 2200×1269 |
| `03-test-cases.jpg` | 多组自测数据点：`#1 AC / #2 WA`、通过 1/2 | 2200×1269 |
| `04-export-pdf.jpg` | 导出 PDF 对话框：范围 / 5 套配色 / 版式 / 内容（只列文件名，不暴露本机路径） | 2200×1269 |
| `05-sync-luogu.jpg` | 同步洛谷：**示例账号**（UID `100000` / `example_user`），非真实账号 | 2200×1269 |
| `06-statistics.jpg` | 学习统计：状态 / 难度 / 算法标签分布 | 2200×1269 |
| `07-theme-light.jpg` | 浅色配色（共三套：深色 / 浅色 / 琥珀） | 2200×1269 |
| `08-ui-english.jpg` | 英文界面（共三语：简中 / 繁中 / English） | 2200×1269 |
| `09-exported-pdf.png` | **导出 PDF 的首页版式**：A4 整页、深色模式、含题面图片，带页面投影 | 1755×2054 |

## 关于截图里的数据

- 题目内容是**公开的洛谷题目**（P1149、P3374 等），不含任何个人记录
- 「同步洛谷」那张用的是**虚构账号**（UID `100000`、用户名 `example_user`），不是任何真实用户
- 截图里**不出现本机绝对路径**（导出目录只显示文件名），也不出现洛谷 UID/用户名

## 可直接粘贴到 README 的片段

```markdown
## 界面预览

![导出 PDF 的首页版式](docs/preview/09-exported-pdf.png)

<table>
  <tr>
    <td width="50%"><img src="docs/preview/01-overview.jpg" alt="主界面总览"><br><sub>文件夹树索引 + 题面（含抓下来的图片）+ 代码编辑器</sub></td>
    <td width="50%"><img src="docs/preview/02-judge.jpg" alt="本地评测"><br><sub>本地评测：样例逐点比对、AC 判定与耗时</sub></td>
  </tr>
  <tr>
    <td><img src="docs/preview/03-test-cases.jpg" alt="自测数据点"><br><sub>多组自测数据点，逐点显示 AC / WA</sub></td>
    <td><img src="docs/preview/04-export-pdf.jpg" alt="导出 PDF"><br><sub>导出 PDF：5 套配色、题目与代码左右分栏</sub></td>
  </tr>
  <tr>
    <td><img src="docs/preview/05-sync-luogu.jpg" alt="同步洛谷"><br><sub>填 UID 同步账号已通过题目</sub></td>
    <td><img src="docs/preview/06-statistics.jpg" alt="学习统计"><br><sub>学习统计：状态 / 难度 / 算法标签</sub></td>
  </tr>
  <tr>
    <td><img src="docs/preview/07-theme-light.jpg" alt="浅色配色"><br><sub>三套界面配色</sub></td>
    <td><img src="docs/preview/08-ui-english.jpg" alt="英文界面"><br><sub>三语界面：简体中文 / 繁體中文 / English</sub></td>
  </tr>
</table>
```

只想放一张的话，用这张当主图：

```markdown
![界面总览](docs/preview/01-overview.jpg)
```
