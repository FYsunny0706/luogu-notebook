// 代码版本历史自测：存/列/读/删、去重、版本上限、路径穿越、备份包含快照
// 用法：先启动服务（默认 8765），再 node tools/test-history.mjs
//      APP_URL=http://127.0.0.1:8790/ node tools/test-history.mjs
// 说明：全程用假题号 P0000TEST，不碰你的真实题目；结束时清理干净。
import fs from "node:fs";
import path from "node:path";

const APP = (process.env.APP_URL ?? "http://127.0.0.1:8765/").replace(/\/$/, "");
const PID = "P0000TEST";
const post = async (p, body = {}) =>
  (await fetch(APP + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

const results = [];
const ok = (name, cond, extra = "") => { results.push(Boolean(cond)); console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`); };
const list = () => post("/api/snapshot/list", { pid: PID });

console.log("===== 1. 存 / 列 / 读 =====");
await post("/api/snapshot/delete", { pid: PID, id: "nothing" }).catch(() => {});
{
  const a = await post("/api/snapshot/save", { pid: PID, code: "int main(){return 0;}\n", label: "第一版" });
  ok("存第一版", a.ok && !a.snapshot.deduped, a.snapshot?.id);
  ok("行数统计正确", a.snapshot?.lines === 2, `${a.snapshot?.lines} 行`);

  const b = await post("/api/snapshot/save", { pid: PID, code: "int main(){return 0;}\n", label: "重复" });
  ok("相同内容去重", b.snapshot?.deduped === true);

  const c = await post("/api/snapshot/save", { pid: PID, code: "int main(){int a;cin>>a;cout<<a;}\n", label: "第二版", result: "AC" });
  const l = await list();
  ok("列表新的在前", l.list[0].id === c.snapshot.id, `${l.list.length} 版`);
  ok("带上了说明与结果标记", l.list[0].label === "第二版" && l.list[0].result === "AC");

  const got = await post("/api/snapshot/get", { pid: PID, id: c.snapshot.id });
  ok("能取回内容", got.ok && got.code.includes("cin"));
}

console.log("\n===== 2. 去重 / 空代码 / 路径穿越 =====");
{
  const empty = await post("/api/snapshot/save", { pid: PID, code: "   \n " });
  ok("空代码被拒", empty.ok === false && /空/.test(empty.error ?? ""), empty.error);

  const bad = await post("/api/snapshot/get", { pid: PID, id: "../../config" });
  ok("路径穿越被拒", bad.ok === false, bad.error);

  const badDel = await post("/api/snapshot/delete", { pid: PID, id: "../../package" });
  ok("删除也挡路径穿越", badDel.ok === false, badDel.error);
}

console.log("\n===== 3. 版本上限（每道题最多 30 版）=====");
{
  for (let i = 0; i < 34; i++) {
    await post("/api/snapshot/save", { pid: PID, code: `// 第 ${i} 版\nint main(){return ${i};}\n`, label: `v${i}` });
  }
  const l = await list();
  ok("最多保留 30 版", l.list.length === 30, `${l.list.length} 版`);
  ok("保留的是最新的", l.list[0].label === "v33", l.list[0].label);
}

console.log("\n===== 4. 删除 =====");
{
  const l = await list();
  const r = await post("/api/snapshot/delete", { pid: PID, id: l.list[0].id });
  ok("删除成功", r.ok && r.list.length === l.list.length - 1, `${l.list.length} → ${r.list?.length}`);
}

console.log("\n===== 5. 完整备份包含代码历史 =====");
{
  const b = await post("/api/backup", {});
  ok("备份成功", b.ok, b.file ? path.basename(b.file) : b.error);
  const manifest = JSON.parse(fs.readFileSync(path.join(b.file, "manifest.json"), "utf8"));
  ok("manifest 记了快照数量", (manifest.snapshots ?? 0) > 0, `snapshots=${manifest.snapshots} images=${manifest.images} problems=${manifest.problems}`);
  ok("备份目录里真的有 snapshots", fs.existsSync(path.join(b.file, "snapshots")));
}

console.log("\n===== 6. 清理测试数据 =====");
{
  let guard = 0;
  while (guard++ < 40) {
    const l = await list();
    if (!l.list?.length) break;
    await post("/api/snapshot/delete", { pid: PID, id: l.list[0].id });
  }
  const l = await list();
  ok("假题号的历史已清空", l.list.length === 0, `${l.list.length} 版`);
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "✅" : "❌"} 代码历史自测 ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
