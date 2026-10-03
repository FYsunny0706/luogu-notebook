// 本地评测：C++ 编译 + 运行。全程用「文件重定向」而不是管道，
// 因为受限沙箱下 child_process 的 pipe stdio 会 EPERM；文件方式沙箱内外都稳。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(root, "build");
const CONFIG_PATH = path.join(root, "config.json");

const MAX_OUTPUT_BYTES = 256 * 1024;
const HARD_TIMEOUT_MS = 10000;
const KILL_GRACE_MS = 300;

/** 所有活着的子进程，退出时统一清理，绝不留下死循环进程 */
const live = new Set();

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { child.kill("SIGKILL"); } catch {}
  if (child.pid) {
    try {
      const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("error", () => {});
      k.unref?.();
    } catch {}
  }
}

export function killAll() {
  for (const c of live) killTree(c);
  live.clear();
}
export function liveCount() {
  return live.size;
}

process.on("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { killAll(); process.exit(0); });
}

function isRealExe(p) {
  return p && fs.existsSync(p) && !/WindowsApps/i.test(p);
}

/** 找 g++：优先配置里的，其次常见安装位置（含小熊猫 RedPanda 自带 MinGW） */
export function detectToolchain() {
  const gppCandidates = [
    "D:\\royqh\\mingw64\\bin\\g++.exe",
    "C:\\royqh\\mingw64\\bin\\g++.exe",
    "C:\\Program Files\\RedPanda-CPP\\mingw64\\bin\\g++.exe",
    "C:\\Program Files (x86)\\RedPanda-CPP\\mingw64\\bin\\g++.exe",
    "C:\\msys64\\mingw64\\bin\\g++.exe",
    "C:\\MinGW\\bin\\g++.exe",
    "C:\\mingw64\\bin\\g++.exe",
    "C:\\TDM-GCC-64\\bin\\g++.exe",
    "C:\\Strawberry\\c\\bin\\g++.exe",
    path.join(os.homedir(), "scoop", "apps", "mingw", "current", "bin", "g++.exe"),
  ];
  return { gpp: gppCandidates.find(isRealExe) ?? "" };
}

export function loadConfig() {
  const detected = detectToolchain();
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { /* 首次运行 */ }
  return { ...detected, ...saved };
}

export function saveConfig(patch) {
  const merged = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function compilerEnv(binDir) {
  const env = { ...process.env };
  // RedPanda 的 MinGW 需要 bin 目录在 PATH 里：
  // 编译期 cc1plus 要加载 libgmp/libwinpthread，运行期 exe 也要找 libwinpthread-1.dll
  if (binDir) env.PATH = `${binDir};${env.PATH ?? ""}`;
  env.LANG = "zh_CN.UTF-8";
  return env;
}

function readCapped(file, cap = MAX_OUTPUT_BYTES) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const len = Math.min(st.size, cap);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    let text = buf.toString("utf8");
    if (st.size > cap) text += `\n…（输出被截断，共 ${(st.size / 1024).toFixed(1)} KB）`;
    return text;
  } catch {
    return "";
  }
}

/**
 * 用文件 fd 做 stdio，彻底绕开管道（受限沙箱下 pipe 会 EPERM）。
 * 超时后必定兑现 promise：即使 taskkill 没能把进程收掉，也不会让 HTTP 请求一直挂着。
 */
export function spawnWithFiles(cmd, args, { cwd, env, stdinFile, stdoutFile, stderrFile, timeoutMs }) {
  return new Promise((resolve) => {
    let fds = [];
    let child;
    const started = process.hrtime.bigint();
    try {
      const stdio = [
        stdinFile ? fs.openSync(stdinFile, "r") : "ignore",
        fs.openSync(stdoutFile, "w"),
        fs.openSync(stderrFile, "w"),
      ];
      fds = stdio.filter((x) => typeof x === "number");
      child = spawn(cmd, args, { cwd, env, stdio, windowsHide: true });
    } catch (e) {
      for (const fd of fds) try { fs.closeSync(fd); } catch {}
      resolve({ exitCode: -1, timeMs: 0, spawnError: e.message, timedOut: false });
      return;
    }

    live.add(child);
    let timedOut = false;
    let settled = false;
    let fallback = null;

    const done = (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      live.delete(child);
      for (const fd of fds) try { fs.closeSync(fd); } catch {}
      resolve({
        exitCode,
        timeMs: Number(process.hrtime.bigint() - started) / 1e6,
        spawnError: spawnError ?? null,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // 兜底：杀不掉也必须给结果，否则请求会永远挂住；顺手再补一刀
      fallback = setTimeout(() => { killTree(child); done(-1, null); }, 800);
    }, timeoutMs);

    child.on("error", (e) => done(-1, e.message));
    child.on("close", (code) => done(code ?? -1, null));
  });
}

function safeId(id) {
  return String(id ?? "job").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "job";
}

function workDirFor(id) {
  const dir = path.join(BUILD_DIR, safeId(id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function compile({ code, id = "job" }) {
  const cfg = loadConfig();
  const dir = workDirFor(id);
  const outFile = path.join(dir, "compile.out");
  const errFile = path.join(dir, "compile.err");
  const cppFile = path.join(dir, "main.cpp");
  const exeFile = path.join(dir, "main.exe");

  fs.writeFileSync(cppFile, code ?? "", "utf8");
  if (!cfg.gpp) {
    return { ok: false, output: "没找到 g++，请在右上角「设置」里指定编译器路径", exe: null, file: cppFile };
  }
  try { fs.rmSync(exeFile, { force: true }); } catch {}

  const args = [
    "-O2", "-std=c++17", "-Wall",
    "-static", "-static-libgcc", "-static-libstdc++",
    "-o", exeFile, cppFile,
  ];
  const r = await spawnWithFiles(cfg.gpp, args, {
    cwd: dir,
    env: compilerEnv(path.dirname(cfg.gpp)),
    stdoutFile: outFile,
    stderrFile: errFile,
    timeoutMs: 30000,
  });
  const output = (readCapped(outFile) + readCapped(errFile)).trim();
  if (r.spawnError) return { ok: false, output: `无法启动编译器: ${r.spawnError}`, exe: null, file: cppFile };
  if (r.timedOut) return { ok: false, output: "编译超时（30s）", exe: null, file: cppFile };
  if (r.exitCode !== 0 || !fs.existsSync(exeFile)) {
    return { ok: false, output: output || `编译失败（退出码 ${r.exitCode}）`, exe: null, file: cppFile };
  }
  return { ok: true, output, exe: exeFile, file: cppFile };
}

function normalizeOut(s) {
  return String(s).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

async function runOne({ compiled, dir, tag, stdin, expected, timeLimitMs, checkOutput, binDir }) {
  const inFile = path.join(dir, `t_${tag}.in`);
  const outFile = path.join(dir, `t_${tag}.out`);
  const errFile = path.join(dir, `t_${tag}.err`);
  fs.writeFileSync(inFile, stdin ?? "", "utf8");

  const limit = Math.max(Number(timeLimitMs) || 1000, 100);
  const r = await spawnWithFiles(compiled.exe, [], {
    cwd: dir,
    env: compilerEnv(binDir ?? ""),
    stdinFile: inFile,
    stdoutFile: outFile,
    stderrFile: errFile,
    timeoutMs: Math.min(limit + KILL_GRACE_MS, HARD_TIMEOUT_MS),
  });

  const stdout = readCapped(outFile);
  const stderr = readCapped(errFile);
  const wallMs = Math.round(r.timeMs);

  let verdict;
  if (r.spawnError) verdict = "RE";
  else if (r.timedOut) verdict = "TLE";
  else if (wallMs > limit + 20) verdict = "TLE";
  else if (r.exitCode !== 0) verdict = "RE";
  else verdict = "OK";

  let matched = null;
  const hasExpected = expected !== undefined && expected !== null && expected !== "" && checkOutput !== false;
  if (verdict === "OK" && hasExpected) {
    matched = normalizeOut(stdout) === normalizeOut(expected);
    verdict = matched ? "AC" : "WA";
  } else if (verdict === "OK") {
    verdict = "DONE";
  }

  return {
    tag,
    stdin: stdin ?? "",
    expected: expected ?? "",
    stdout,
    stderr,
    timeMs: wallMs,
    exitCode: r.exitCode,
    verdict,
    matched,
  };
}

/** 编译一次，跑一组测试点 */
export async function judge({ code, id = "job", tests = [], timeLimitMs = 1000 }) {
  const dir = workDirFor(id);
  const compiled = await compile({ code, id });
  if (!compiled.ok) {
    return { ok: false, phase: "compile", compileOutput: compiled.output, tests: [] };
  }
  const cfg = loadConfig();
  const binDir = cfg.gpp ? path.dirname(cfg.gpp) : "";
  const results = [];
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    results.push(await runOne({
      compiled,
      dir,
      tag: i + 1,
      stdin: t.input ?? t.stdin ?? "",
      expected: t.output ?? t.expected ?? "",
      timeLimitMs,
      checkOutput: t.check !== false,
      binDir,
    }));
  }
  const allAc = results.length > 0 && results.every((r) => r.verdict === "AC" || r.verdict === "DONE");
  return { ok: true, phase: "run", compileOutput: compiled.output, tests: results, allAc, dir };
}

/** 服务启动时预热一次：Windows 首次执行新 exe 会被杀软扫描拖慢 ~5s */
export async function warmup() {
  try {
    const cfg = loadConfig();
    if (!cfg.gpp) return;
    const dir = workDirFor("_warmup");
    const src = path.join(dir, "warm.cpp");
    const exe = path.join(dir, "warm.exe");
    fs.writeFileSync(src, "int main(){return 0;}\n", "utf8");
    const r = await spawnWithFiles(cfg.gpp, ["-O2", "-static", "-o", exe, src], {
      cwd: dir, env: compilerEnv(path.dirname(cfg.gpp)),
      stdoutFile: path.join(dir, "c.out"), stderrFile: path.join(dir, "c.err"), timeoutMs: 30000,
    });
    if (r.exitCode === 0) {
      await spawnWithFiles(exe, [], {
        cwd: dir, env: compilerEnv(path.dirname(cfg.gpp)), stdinFile: null,
        stdoutFile: path.join(dir, "r.out"), stderrFile: path.join(dir, "r.err"), timeoutMs: 5000,
      });
    }
  } catch { /* 预热失败不影响任何功能 */ }
}

export { BUILD_DIR };
