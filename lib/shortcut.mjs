// 在桌面创建快捷方式（指向 start.bat）。
// 为什么需要它：PWA 装出来的桌面图标只是个网址，服务没启动时打开就是「网页无法访问」。
// 用 start.bat 的快捷方式则双击就会先把服务跑起来，再自动打开浏览器。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithFiles } from "./judge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(ROOT, "build");

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 建一个桌面快捷方式：
 *   Windows → .lnk（带图标，双击即启动服务）
 *   其它系统 → 桌面上的 .sh / .desktop 说明文件（尽力而为）
 */
export async function createDesktopShortcut({ name = "洛谷刷题本" } = {}) {
  const desktop = path.join(os.homedir(), "Desktop");
  const desktopAlt = path.join(os.homedir(), "桌面");   // 中文系统的桌面目录名也是 Desktop，这里只是兜底
  const desk = fs.existsSync(desktop) ? desktop : desktopAlt;
  if (!fs.existsSync(desk)) throw new Error(`找不到桌面目录：${desk}`);

  if (process.platform !== "win32") {
    // 非 Windows：放一个可执行的 .sh 在桌面（拿不到 .lnk 那种图标，但至少能双击启动）
    const sh = path.join(desk, `${name}.sh`);
    fs.writeFileSync(
      sh,
      `#!/bin/sh\n# 双击运行即可启动洛谷刷题本\nexec ${psQuote(path.join(ROOT, "start.sh"))}\n`,
      { mode: 0o755 }
    );
    return { ok: true, file: sh, kind: "sh" };
  }

  const bat = path.join(ROOT, "start.bat");
  if (!fs.existsSync(bat)) throw new Error("找不到 start.bat，无法创建快捷方式");
  const ico = path.join(ROOT, "public", "icons", "icon.ico");
  const lnk = path.join(desk, `${name}.lnk`);

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const scriptPath = path.join(BUILD_DIR, "make-shortcut.ps1");
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "$ws = New-Object -ComObject WScript.Shell",
    `$lnk = $ws.CreateShortcut(${psQuote(lnk)})`,
    `$lnk.TargetPath = ${psQuote(bat)}`,
    `$lnk.WorkingDirectory = ${psQuote(ROOT)}`,
    `$lnk.Description = ${psQuote(name + " - 本地刷题记录本")}`,
    fs.existsSync(ico) ? `$lnk.IconLocation = ${psQuote(ico + ",0")}` : "",
    "$lnk.WindowStyle = 7",   // 7 = 最小化，启动时黑窗口不抢焦点
    "$lnk.Save()",
    `Write-Output ${psQuote(lnk)}`,
  ].filter(Boolean).join("\n");

  // Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解析（中文会烂），所以必须带 BOM
  fs.writeFileSync(scriptPath, "\uFEFF" + ps, "utf8");

  const out = path.join(BUILD_DIR, "shortcut.out");
  const err = path.join(BUILD_DIR, "shortcut.err");
  const exe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const r = await spawnWithFiles(exe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    cwd: ROOT, env: { ...process.env },
    stdinFile: null, stdoutFile: out, stderrFile: err, timeoutMs: 30000,
  });
  const errText = (() => { try { return fs.readFileSync(err, "utf8").trim(); } catch { return ""; } })();
  if (r.exitCode !== 0 || !fs.existsSync(lnk)) {
    throw new Error(`创建快捷方式失败${errText ? "：" + errText.slice(0, 200) : ""}`);
  }
  return { ok: true, file: lnk, kind: "lnk" };
}
