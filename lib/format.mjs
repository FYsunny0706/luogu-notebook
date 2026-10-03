// 代码格式化：调用 clang-format；本机没装时给出可操作的提示并支持一键从 GitHub 取
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithFiles, loadConfig } from "./judge.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(root, "build");
const TOOLS_BIN = path.join(root, "tools", "bin");

export const STYLE_PRESETS = [
  { id: "file", name: "项目 .clang-format（若存在）" },
  { id: "Google", name: "Google（2 空格缩进）" },
  { id: "LLVM", name: "LLVM" },
  { id: "Chromium", name: "Chromium" },
  { id: "Mozilla", name: "Mozilla" },
  { id: "WebKit", name: "WebKit" },
  { id: "OI", name: "竞赛风格（4 空格 + 大括号换行）" },
];

const CF_DOWNLOAD = {
  win32: "https://github.com/muttleyxd/clang-tools-static-binaries/releases/download/master-796e77c/clang-format-20_windows-amd64.exe",
  linux: "https://github.com/muttleyxd/clang-tools-static-binaries/releases/download/master-796e77c/clang-format-20_linux-amd64",
  darwin: "https://github.com/muttleyxd/clang-tools-static-binaries/releases/download/master-796e77c/clang-format-20_macosx-amd64",
};

export function findClangFormat() {
  const cfg = loadConfig();
  if (cfg.clangFormat && fs.existsSync(cfg.clangFormat)) return cfg.clangFormat;

  // 项目自带的优先
  const local = [
    path.join(TOOLS_BIN, process.platform === "win32" ? "clang-format.exe" : "clang-format"),
    path.join(TOOLS_BIN, "clang-format"),
  ];
  for (const p of local) if (fs.existsSync(p)) return p;

  // 常见安装位置
  const cands = process.platform === "win32"
    ? [
        "C:\\Program Files\\LLVM\\bin\\clang-format.exe",
        "C:\\Program Files (x86)\\LLVM\\bin\\clang-format.exe",
        "C:\\msys64\\mingw64\\bin\\clang-format.exe",
        "C:\\msys64\\ucrt64\\bin\\clang-format.exe",
        "C:\\Program Files\\RedPanda-CPP\\clang-format.exe",
        "D:\\royqh\\clang-format.exe",
        path.join(os.homedir(), "scoop", "apps", "llvm", "current", "bin", "clang-format.exe"),
      ]
    : ["/usr/bin/clang-format", "/usr/local/bin/clang-format", "/opt/homebrew/bin/clang-format"];

  for (const p of cands) if (fs.existsSync(p)) return p;

  // g++ 同目录（有些发行包放一起）
  const gpp = loadConfig().gpp;
  if (gpp) {
    const sib = path.join(path.dirname(gpp), process.platform === "win32" ? "clang-format.exe" : "clang-format");
    if (fs.existsSync(sib)) return sib;
  }
  return "";
}

function styleArg(style) {
  if (!style || style === "file") return "-style=file";
  if (style === "OI") {
    return "-style={BasedOnStyle: LLVM, IndentWidth: 4, TabWidth: 4, UseTab: Never, "
      + "BreakBeforeBraces: Allman, ColumnLimit: 0, AllowShortFunctionsOnASingleLine: None, "
      + "AllowShortIfStatementsOnASingleLine: false, IndentCaseLabels: false, "
      + "PointerAlignment: Right, SortIncludes: false}";
  }
  return `-style=${style}`;
}

export async function formatCode(code, style = "file", filename = "main.cpp") {
  const bin = findClangFormat();
  if (!bin) {
    throw new Error(
      "没找到 clang-format。可以在「设置」里指定它的路径，或点「下载 clang-format」从 GitHub 获取。\n" +
      `手动下载地址：${CF_DOWNLOAD[process.platform] ?? CF_DOWNLOAD.win32}`
    );
  }
  const dir = path.join(BUILD_DIR, "format");
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, filename);
  const out = path.join(dir, "formatted.cpp");
  const err = path.join(dir, "format.err");
  fs.writeFileSync(src, code ?? "", "utf8");

  const r = await spawnWithFiles(bin, [styleArg(style), src], {
    cwd: dir,
    env: { ...process.env },
    stdinFile: null,
    stdoutFile: out,
    stderrFile: err,
    timeoutMs: 20000,
  });
  const errText = (() => { try { return fs.readFileSync(err, "utf8").trim(); } catch { return ""; } })();
  if (r.exitCode !== 0) {
    throw new Error(`clang-format 执行失败（退出码 ${r.exitCode}）\n${errText}`.trim());
  }
  const formatted = (() => { try { return fs.readFileSync(out, "utf8"); } catch { return ""; } })();
  if (!formatted.trim()) throw new Error(`clang-format 没有输出内容\n${errText}`.trim());
  return { code: formatted, bin, style };
}

/** 从 GitHub 取一份独立 clang-format（网络不通时会明确报错） */
export async function downloadClangFormat() {
  const url = CF_DOWNLOAD[process.platform] ?? CF_DOWNLOAD.win32;
  fs.mkdirSync(TOOLS_BIN, { recursive: true });
  const dest = path.join(TOOLS_BIN, process.platform === "win32" ? "clang-format.exe" : "clang-format");
  let res;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    throw new Error(
      `下载失败：${e.cause?.message ?? e.message}\n` +
      `（有些网络访问不了 GitHub 的资源服务器，可以手动下载后放到 tools/bin/ 目录）\n${url}`
    );
  }
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}\n${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 200000) throw new Error(`下载到的文件只有 ${buf.length} 字节，不像是可执行文件`);
  fs.writeFileSync(dest, buf);
  if (process.platform !== "win32") {
    try { fs.chmodSync(dest, 0o755); } catch {}
  }
  return { file: dest, size: buf.length };
}
