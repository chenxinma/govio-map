/**
 * T1.3 验证脚本：权限确认记录进审计留痕。
 *
 * 用法：`npm run verify:audit`（纯本地：临时目录 + `.govio/sessions/` 下的一次性会话文件，
 * 不调用 govio-cli、不调用模型、不读任何数据内容）。
 *
 * 覆盖七件事：
 *  1. 审计条目格式：请求/决策成对、decisionId 一致、时间戳 ISO、命令原文不被改写
 *  2. 三种决策：allow / deny（带 reason）/ edit（**改前 + 改后命令都在记录里**）
 *  3. 系统代答的决策（超时 / 中止 / 会话重置）与 Accept All 的模式变更事件
 *  4. Manifest 关联：命令 → decisionId 索引（含空白差异容错）→ `buildManifest.permissionDecisionId`
 *  5. 真实扩展事件流：tool_call 过确认门 → tool_result 建 dataFrame 节点，节点 Manifest 带 decisionId；
 *     edit 后 agent 重发命令 → 新请求记录 `followsDecisionId` 指回那次 edit 决策
 *  6. 生命周期：JSONL 追加不覆盖（命令含换行也不拆行）、读回往返、坏行跳过、deleteSession 一并删除
 *  7. 会话尚未落盘（拿不到 session file）时确认流不受影响
 *
 * 任一断言失败退出码为 1。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PERMISSION_AUDIT_VERSION,
  appendPermissionAudit,
  auditPathFor,
  deletePermissionAudit,
  parsePermissionAuditLine,
  readPermissionAudit,
  setAuditSessionResolver,
  type PermissionAuditEntry,
  type PermissionDecisionAuditEntry,
  type PermissionModeAuditEntry,
  type PermissionRequestAuditEntry,
} from "../server/permission-audit.js";
import {
  PermissionManager,
  permissionManager,
  type PermissionDecisionInput,
  type PermissionRequest,
} from "../server/permission-manager.js";
import { buildManifest } from "../server/analysis-manifest.js";
import { deleteSession, getSessionDir, saveCanvas } from "../server/session-history.js";
import govioCanvasExtension, { shouldAskPermission, readsDataContent, observeInfoTarget } from "../server/extensions/govio-canvas.js";
import { flushGovioNodes } from "../server/govio-node-queue.js";
import type { AnalysisManifest } from "../src/types/manifest.js";

const failures: string[] = [];
let checks = 0;

function check(label: string, cond: boolean, detail?: string): void {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function isRequest(e: PermissionAuditEntry): e is PermissionRequestAuditEntry {
  return e.type === "permission_request";
}
function isDecision(e: PermissionAuditEntry): e is PermissionDecisionAuditEntry {
  return e.type === "permission_decision";
}
function isMode(e: PermissionAuditEntry): e is PermissionModeAuditEntry {
  return e.type === "permission_mode";
}

/** 审计 sidecar 写到临时目录里的一次性「会话」，不碰真实会话文件 */
const dir = mkdtempSync(join(tmpdir(), "govio-audit-"));
const sessionFile = join(dir, "2026-10-30T15-00-00-000Z_sess-verify.jsonl");
writeFileSync(sessionFile, "");
setAuditSessionResolver(() => ({ sessionId: "sess-verify", sessionFile }));

const LOAD_CMD = 'govio-cli observe load --name df_audit --datasource sales --sql "SELECT id, amt FROM orders" -o out/all.parquet 2>&1';

try {
  // ── 1. 条目格式 + allow 决策 ────────────────────────────────────────────
  console.log("\n[1] 审计条目格式与 allow 决策");
  const mgr = new PermissionManager({ timeoutMs: 5_000 });
  const pushed: PermissionRequest[] = [];
  mgr.onRequest((req) => pushed.push(req));

  const allowPromise = mgr.requestPermission(LOAD_CMD, "call-allow");
  check("确认请求推给了前端（requestId + 命令原文）", pushed.length === 1 && pushed[0].command === LOAD_CMD);
  check("requestId 就是决策 ID（同一次确认只有一个标识）", pushed[0].requestId.startsWith("pd-"));
  mgr.resolve(pushed[0].requestId, { decision: "allow" });
  const allowResult = await allowPromise;
  check("allow 决策回传 decisionId", allowResult.decision === "allow" && allowResult.decisionId === pushed[0].requestId);
  check("toolCallId 与决策 ID 已建立关联（供 Manifest 回填）", mgr.decisionIdForExecution(LOAD_CMD, "call-allow") === allowResult.decisionId);
  check("toolCallId 优先于命令文本（命令不同也能对回本次决策）", mgr.decisionIdForExecution("govio-cli observe info --name df_audit", "call-allow") === allowResult.decisionId);
  check("没有 toolCallId 时退回命令文本关联", mgr.decisionIdForExecution(LOAD_CMD) === allowResult.decisionId);

  {
    const entries = readPermissionAudit(sessionFile);
    check(
      "sidecar 路径为 <session-file>.audit.jsonl",
      auditPathFor(sessionFile) === `${sessionFile}.audit.jsonl` && existsSync(auditPathFor(sessionFile)),
    );
    check("一次确认写下「请求 + 决策」两条记录", entries.length === 2, `actual=${entries.length}`);
    const [req, dec] = entries;
    check("两条记录同一个 decisionId", req.decisionId === dec.decisionId && req.decisionId === allowResult.decisionId);
    check("记录带结构版本号", req.v === PERMISSION_AUDIT_VERSION && dec.v === PERMISSION_AUDIT_VERSION);
    check("记录带会话 ID 与会话文件", entries.every((e) => e.sessionId === "sess-verify" && e.sessionFile === sessionFile));
    check("时间戳为 ISO 8601", entries.every((e) => Number.isFinite(Date.parse(e.at))));
    check("决策时间不早于请求时间", Date.parse(dec.at) >= Date.parse(req.at));
    check("请求记录命令原文（未改写）", isRequest(req) && req.command === LOAD_CMD);
    check("请求记录标注走人工确认门", isRequest(req) && req.gate === "ask");
    check("决策记录 allow / 来源为用户", isDecision(dec) && dec.decision === "allow" && dec.source === "user");
    check("决策记录耗时非负", isDecision(dec) && dec.elapsedMs >= 0);
    check("allow 决策不含 editedCommand / reason 字段", isDecision(dec) && !("editedCommand" in dec) && !("reason" in dec));
  }

  // ── 2. deny 与 edit 决策 ───────────────────────────────────────────────
  console.log("\n[2] deny 记录原因、edit 记录改前改后命令");
  const denyCmd = 'govio-cli observe load --name df_secret --datasource hr --sql "SELECT id_card FROM emp" -o out/emp.parquet';
  const denyPromise = mgr.requestPermission(denyCmd);
  mgr.resolve(pushed[1].requestId, { decision: "deny", reason: "含身份证号，不允许导出" });
  const denyResult = await denyPromise;
  check("deny 决策回传 decisionId", denyResult.decision === "deny" && denyResult.decisionId === pushed[1].requestId);
  check("被拒绝的命令不进入 Manifest 关联索引", mgr.decisionIdForExecution(denyCmd) === null);

  const editCmd = 'govio-cli observe load --name df_orders --datasource sales --sql "SELECT * FROM orders" -o out/orders.parquet';
  const editedCmd = 'govio-cli observe load --name df_orders --datasource sales --sql "SELECT order_id, amount FROM orders LIMIT 100" -o out/orders_sample.parquet';
  const editPromise = mgr.requestPermission(editCmd);
  mgr.resolve(pushed[2].requestId, { decision: "edit", editedCommand: editedCmd, reason: "只取必要列并抽样" });
  const editResult = await editPromise;
  check("edit 决策回传修改后命令", editResult.decision === "edit" && editResult.editedCommand === editedCmd);
  check("修改后的命令进入关联索引（agent 重发时挂同一次决策）", mgr.decisionIdForExecution(editedCmd) === editResult.decisionId);
  check("被改写的原命令不再指向该决策", mgr.decisionIdForExecution(editCmd) === null);

  {
    const entries = readPermissionAudit(sessionFile);
    const decisions = entries.filter(isDecision);
    const requests = entries.filter(isRequest);
    const deny = decisions.find((d) => d.decisionId === denyResult.decisionId);
    const edit = decisions.find((d) => d.decisionId === editResult.decisionId);
    check("deny 记录原因原文", deny?.reason === "含身份证号，不允许导出" && deny?.source === "user");
    check("deny 记录命令原文", deny?.command === denyCmd);
    check("edit 记录**修改前**命令", edit?.command === editCmd);
    check("edit 记录**修改后**命令", edit?.editedCommand === editedCmd);
    check("edit 记录原因", edit?.reason === "只取必要列并抽样");
    check(
      "每次确认都有配对的请求记录",
      requests.length === decisions.length && requests.every((r) => decisions.some((d) => d.decisionId === r.decisionId)),
    );
  }

  // ── 3. 系统代答的决策 + 模式变更 ───────────────────────────────────────
  console.log("\n[3] 超时 / 中止 / Accept All 模式事件 / 会话重置");
  const short = new PermissionManager({ timeoutMs: 30 });
  const timeoutResult = await short.requestPermission(LOAD_CMD);
  check("超时自动拒绝并给出原因", timeoutResult.decision === "deny" && (timeoutResult.reason ?? "").includes("超时"));
  {
    const dec = readPermissionAudit(sessionFile).filter(isDecision).find((d) => d.decisionId === timeoutResult.decisionId);
    check("超时决策来源记为 timeout", dec?.source === "timeout" && dec?.decision === "deny");
    check("超时决策记录了等待时长", (dec?.elapsedMs ?? 0) >= 25, `elapsedMs=${dec?.elapsedMs}`);
    // 超时之后用户再点允许：决策不再生效，但必须留下一条「未生效」记录，
    // 否则「用户点了却没反应」在审计里查无此事
    short.resolve(timeoutResult.decisionId, { decision: "allow" });
    const late = readPermissionAudit(sessionFile).filter(isDecision).filter((d) => d.decisionId === timeoutResult.decisionId);
    check("迟到决策补记一条「未生效」留痕（不改变已生效的超时拒绝）",
      late.length === 2 && late[0].source === "timeout" && late[1].source === "user"
      && late[1].decision === "allow" && late[1].reason === "决策已失效（请求此前已被超时/中止/会话重置拒绝），未生效",
      `entries=${late.length}`);
    // 幂等：超时后卡片可能仍挂在界面上，用户连点两次只补记一次，
    // 否则审计日志里会堆出多条互相矛盾的 source:"user" 行
    short.resolve(timeoutResult.decisionId, { decision: "deny" });
    const lateAgain = readPermissionAudit(sessionFile).filter(isDecision).filter((d) => d.decisionId === timeoutResult.decisionId);
    check("连续两次迟到 resolve 后同 decisionId 仍恰 2 条记录（补记幂等）",
      lateAgain.length === 2 && lateAgain[1].decision === "allow",
      `entries=${lateAgain.length}`);
    // 伪造/垃圾 requestId 不灌日志
    const junkBefore = readPermissionAudit(sessionFile).length;
    short.resolve("not-a-decision-id", { decision: "allow" });
    check("非 pd- 形态的 requestId 不产生审计记录", readPermissionAudit(sessionFile).length === junkBefore);
  }

  const abortMgr = new PermissionManager();
  const abortPushed: PermissionRequest[] = [];
  abortMgr.onRequest((req) => abortPushed.push(req));
  const abortPromise = abortMgr.requestPermission(LOAD_CMD);
  abortMgr.denyPending("用户中止");
  const abortResult = await abortPromise;
  check("中止时挂起请求被自动拒绝", abortResult.decision === "deny" && abortResult.reason === "用户中止");
  check(
    "中止决策来源记为 abort",
    readPermissionAudit(sessionFile).filter(isDecision).find((d) => d.decisionId === abortResult.decisionId)?.source === "abort",
  );
  abortMgr.resolve(abortPushed[0].requestId, { decision: "allow" });
  {
    const abortEntries = readPermissionAudit(sessionFile).filter(isDecision).filter((d) => d.decisionId === abortResult.decisionId);
    check(
      "已生效的中止拒绝不被改写；迟到决策只补记「未生效」留痕",
      abortEntries.length === 2 && abortEntries[0].source === "abort" && abortEntries[1].source === "user"
      && abortEntries[1].reason === "决策已失效（请求此前已被超时/中止/会话重置拒绝），未生效",
      `entries=${abortEntries.length}`,
    );
  }

  const modesBefore = readPermissionAudit(sessionFile).filter(isMode).length;
  const allMgr = new PermissionManager();
  const allPushed: PermissionRequest[] = [];
  allMgr.onRequest((req) => allPushed.push(req));
  allMgr.setAcceptAll(true);
  allMgr.setAcceptAll(true); // 状态没变 → 不重复记账
  {
    const modes = readPermissionAudit(sessionFile).filter(isMode);
    check("Accept All 写入一条模式变更事件（重复设置不重复记账）", modes.length === modesBefore + 1, `before=${modesBefore} after=${modes.length}`);
    const mode = modes[modes.length - 1];
    check("模式事件记为开启放行 + 原因 + 时间戳", mode.acceptAll === true && mode.reason.includes("Accept All") && Number.isFinite(Date.parse(mode.at)));
    check("模式事件有独立 ID（pm- 前缀）", mode.decisionId.startsWith("pm-"));
    check("模式事件同样带会话归属", mode.sessionId === "sess-verify" && mode.sessionFile === sessionFile);
    check("模式事件记录当时挂起的请求数", mode.pendingAffected === 0);
  }

  // 放行模式下的请求：不打扰前端，但一样留痕（否则放行期间的取数无任何记录）
  const autoResult = await allMgr.requestPermission(LOAD_CMD);
  check("全局放行下不打扰前端", allPushed.length === 0);
  check("全局放行仍返回决策 ID", autoResult.decision === "allow" && autoResult.decisionId.startsWith("pd-"));
  check("全局放行期间执行的命令也能关联决策", allMgr.decisionIdForExecution(LOAD_CMD) === autoResult.decisionId);
  {
    const entries = readPermissionAudit(sessionFile).filter((e) => e.decisionId === autoResult.decisionId);
    const req = entries.find(isRequest);
    const dec = entries.find(isDecision);
    check("自动放行记为 gate=accept-all", req !== undefined && req.gate === "accept-all");
    check("自动放行决策来源记为 accept-all、耗时 0", dec?.source === "accept-all" && dec?.elapsedMs === 0);
  }

  const clearedMgr = new PermissionManager();
  clearedMgr.onRequest(() => { /* 不响应：模拟用户还没点，就切了会话 */ });
  const clearedPromise = clearedMgr.requestPermission(LOAD_CMD);
  clearedMgr.setAcceptAll(true);
  clearedMgr.clearAll();
  const clearedResult = await clearedPromise;
  check("会话重置时挂起请求被拒绝", clearedResult.decision === "deny" && clearedResult.reason === "会话已重置");
  check("会话重置后放行模式失效", clearedMgr.isAcceptAll() === false);
  {
    const modes = readPermissionAudit(sessionFile).filter(isMode);
    const off = modes[modes.length - 1];
    check("会话重置写下「放行关闭」模式事件", off.acceptAll === false && off.reason.includes("会话重置"));
    check("模式事件记录受影响的挂起请求数", off.pendingAffected === 1, `pendingAffected=${off.pendingAffected}`);
    check(
      "重置导致的拒绝来源记为 reset",
      readPermissionAudit(sessionFile).filter(isDecision).find((d) => d.decisionId === clearedResult.decisionId)?.source === "reset",
    );
  }

  // 决策索引随会话失效：否则切会话后命令文本兜底会把新会话的执行错绑到旧会话的 decisionId
  {
    const idxMgr = new PermissionManager();
    idxMgr.onRequest((req) => idxMgr.resolve(req.requestId, { decision: "allow" }));
    const idxResult = await idxMgr.requestPermission(LOAD_CMD, "call-idx");
    check("clearAll 前决策索引可用", idxMgr.decisionIdForExecution(LOAD_CMD, "call-idx") === idxResult.decisionId);
    idxMgr.clearAll();
    check(
      "clearAll 清空命令与 toolCallId 两张决策索引（跨会话不再兜底错绑）",
      idxMgr.decisionIdForExecution(LOAD_CMD, "call-idx") === null && idxMgr.decisionIdForExecution(LOAD_CMD) === null,
    );
  }

  // ── 4. Manifest 关联 ───────────────────────────────────────────────────
  console.log("\n[4] Manifest 关联 decisionId");
  {
    // 命令文本是 toolCallId 缺失时的兜底关联键：agent 重发时的换行/缩进差异要能容忍
    const reformatted = LOAD_CMD.replace("2>&1", "\n  2>&1");
    const decisionId = mgr.decisionIdForExecution(reformatted);
    check("命令空白差异不影响关联", decisionId === allowResult.decisionId);
    const manifest: AnalysisManifest = buildManifest({
      origin: "observe-load",
      sql: "SELECT id, amt FROM orders",
      datasource: "sales",
      dfName: "df_audit",
      columns: [{ name: "id", dtype: "int64" }, { name: "amt", dtype: "float64" }],
      rowCount: 1200,
      columnCount: 2,
      context: { sessionId: "sess-verify" },
      permissionDecisionId: decisionId,
    });
    check("Manifest.permissionDecisionId = 确认门的决策 ID", manifest.permissionDecisionId === allowResult.decisionId);
    const audited = readPermissionAudit(sessionFile).filter((e) => e.decisionId === manifest.permissionDecisionId);
    check("按 Manifest 的 decisionId 能在审计日志里查到请求与决策", audited.some(isRequest) && audited.some(isDecision));
    const noGate = buildManifest({
      origin: "observe-load",
      sql: "SELECT 1",
      datasource: "sales",
      dfName: "df_plain",
      context: { sessionId: "sess-verify" },
      permissionDecisionId: mgr.decisionIdForExecution('govio-cli observe load --name df_plain --datasource sales --sql "SELECT 1"'),
    });
    check("未过确认门的加载 Manifest 记为 null（而非省略字段）", noGate.permissionDecisionId === null && "permissionDecisionId" in noGate);
  }

  // ── 5. 真实扩展事件流：确认门 → 节点 Manifest ──────────────────────────
  console.log("\n[5] govio-canvas 事件流：确认门决策写进 dataFrame 节点 Manifest");
  {
    permissionManager.clearAll();
    type Handler = (event: unknown, ctx: unknown) => unknown;
    const handlers = new Map<string, Handler>();
    const piStub = {
      registerTool: () => {},
      on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; },
    };
    govioCanvasExtension(piStub as unknown as Parameters<typeof govioCanvasExtension>[0]);
    const toolCall = handlers.get("tool_call");
    const toolResult = handlers.get("tool_result");
    check("扩展注册了 tool_call / tool_result 处理器", typeof toolCall === "function" && typeof toolResult === "function");

    const piCtx = {
      sessionManager: { getSessionId: () => "sess-verify-e2e" },
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    };
    const bashCall = (id: string, command: string) => ({ type: "tool_call", toolCallId: id, toolName: "bash", input: { command } });
    const bashResult = (id: string, command: string, rows: number) => ({
      toolName: "bash",
      toolCallId: id,
      isError: false,
      input: { command },
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          rows,
          columns: 2,
          column_info: [{ name: "id", dtype: "int64" }, { name: "amt", dtype: "float64" }],
        }),
      }],
    });

    // 第一轮：用户点「允许」→ 命令执行 → dataFrame 节点带上该决策 ID
    const frontend: PermissionRequest[] = [];
    const unsubAllow = permissionManager.onRequest((req) => {
      frontend.push(req);
      permissionManager.resolve(req.requestId, { decision: "allow" });
    });
    const gateCmd = 'govio-cli observe load --name df_gated --datasource sales --sql "SELECT id, amt FROM orders" -o out/gated.parquet 2>&1';
    const gateOutcome = await toolCall?.(bashCall("t1", gateCmd), piCtx);
    check("用户允许后不阻断 bash 执行", gateOutcome === undefined);
    check("确认请求确实经过了前端通道", frontend.length === 1 && frontend[0].command === gateCmd);
    await toolResult?.(bashResult("t1", gateCmd, 1200), piCtx);
    const gatedEvent = flushGovioNodes().find((e) => e.nodeType === "dataFrame");
    check("observe load 生成 dataFrame 节点事件", gatedEvent !== undefined);
    check(
      "节点 Manifest 关联到本次确认的 decisionId",
      gatedEvent?.manifest?.permissionDecisionId === frontend[0].requestId,
      `actual=${gatedEvent?.manifest?.permissionDecisionId}`,
    );
    check(
      "节点 Manifest 其余留痕未受影响",
      gatedEvent?.manifest?.origin === "observe-load" &&
        gatedEvent?.manifest?.dfName === "df_gated" &&
        gatedEvent?.manifest?.sessionId === "sess-verify-e2e" &&
        gatedEvent?.manifest?.checksum !== undefined,
    );
    unsubAllow();

    // 第二轮：用户改命令（仍带 -o）→ agent 用改后命令重发 → 新请求指回那次 edit 决策
    const editedCmdRun = 'govio-cli observe load --name df_edited --datasource sales --sql "SELECT id FROM orders LIMIT 100" -o out/edited.parquet 2>&1';
    const script: PermissionDecisionInput[] = [
      { decision: "edit", editedCommand: editedCmdRun, reason: "只取必要列并抽样" },
      { decision: "allow" },
    ];
    const editRound: PermissionRequest[] = [];
    const unsubEdit = permissionManager.onRequest((req) => {
      editRound.push(req);
      const next = script.shift();
      if (next) permissionManager.resolve(req.requestId, next);
    });
    const originalCmd = 'govio-cli observe load --name df_edited --datasource sales --sql "SELECT * FROM orders" -o out/edited.parquet 2>&1';
    const blocked = (await toolCall?.(bashCall("t2", originalCmd), piCtx)) as { block?: boolean; reason?: string } | undefined;
    check("edit 决策阻断原命令", blocked?.block === true);
    check("阻断原因里带上修改后的命令", (blocked?.reason ?? "").includes("LIMIT 100"));
    const rerunOutcome = await toolCall?.(bashCall("t3", editedCmdRun), piCtx);
    check("修改后的命令重新过确认门后放行", rerunOutcome === undefined);
    check("改前改后各触发一次确认", editRound.length === 2);
    await toolResult?.(bashResult("t3", editedCmdRun, 100), piCtx);
    const editedEvent = flushGovioNodes().find((e) => e.nodeType === "dataFrame");
    check(
      "改写后执行的结果关联到**重发那次**决策",
      editedEvent?.manifest?.permissionDecisionId === editRound[1].requestId,
      `actual=${editedEvent?.manifest?.permissionDecisionId}`,
    );
    // 重发的命令文本与 edit 决策索引的 editedCommand 一致：toolCallId 未命中时由命令文本兜底
    check(
      "命令文本兜底也能对回重发那次决策",
      permissionManager.decisionIdForExecution(editedCmdRun) === editRound[1].requestId,
    );
    unsubEdit();

    // 不带 -o 的加载：不过确认门 → Manifest 记 null
    const plainCmd = 'govio-cli observe load --name df_plain --datasource sales --sql "SELECT 1" 2>&1';
    const plainOutcome = await toolCall?.(bashCall("t4", plainCmd), piCtx);
    check("不带 -o 的加载不触发确认门", plainOutcome === undefined);
    await toolResult?.(bashResult("t4", plainCmd, 1), piCtx);
    const plainEvent = flushGovioNodes().find((e) => e.nodeType === "dataFrame");
    check("未过确认门的节点 Manifest 记 null", plainEvent?.manifest?.permissionDecisionId === null);

    {
      const requests = readPermissionAudit(sessionFile).filter(isRequest);
      const rerun = requests.find((r) => r.decisionId === editRound[1].requestId);
      check(
        "重发命令的请求记录指回 edit 决策（followsDecisionId）",
        rerun?.followsDecisionId === editRound[0].requestId,
        `actual=${rerun?.followsDecisionId}`,
      );
      const first = requests.find((r) => r.decisionId === editRound[0].requestId);
      check("首次请求没有 followsDecisionId", first !== undefined && !("followsDecisionId" in first));
      check("未过确认门的命令不产生任何审计记录", requests.every((r) => r.command !== plainCmd));
    }
  }

  // ── 6. 持久化与生命周期 ────────────────────────────────────────────────
  console.log("\n[6] JSONL 追加、读回、坏行容错、deleteSession 清理");
  {
    const path = auditPathFor(sessionFile);
    const entries = readPermissionAudit(sessionFile);
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    check(
      "追加写：记录数与文件行数一致（历史未被覆盖）",
      lines.length === entries.length && entries.length > 10,
      `lines=${lines.length} entries=${entries.length}`,
    );
    check("每行都是一条完整 JSON", lines.every((l) => parsePermissionAuditLine(l) !== null));
    check("文件以换行结尾（可继续追加）", raw.endsWith("\n"));

    // 命令含换行时不能被拆成两行记录
    const multilineCmd = `govio-cli observe load --name df_ml --datasource sales --sql "SELECT id\nFROM orders" -o out/ml.parquet`;
    const mlMgr = new PermissionManager();
    mlMgr.onRequest((req) => mlMgr.resolve(req.requestId, { decision: "allow" }));
    const mlResult = await mlMgr.requestPermission(multilineCmd);
    const mlEntries = readPermissionAudit(sessionFile).filter((e) => e.decisionId === mlResult.decisionId);
    check("多行命令仍是一条请求 + 一条决策", mlEntries.length === 2);
    check("多行命令原文完整保留（含换行）", mlEntries.filter(isRequest)[0]?.command === multilineCmd);
    check(
      "多行命令没有把 JSONL 拆行",
      readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").length === entries.length + 2,
    );

    // 坏行（写入被截断 / 手工编辑）跳过而不抛错
    appendFileSync(path, "{ 半截 JSON\n", "utf8");
    appendFileSync(path, "\n", "utf8");
    check("坏行与空行被跳过，其余记录照常读回", readPermissionAudit(sessionFile).length === entries.length + 2);
  }

  // deleteSession：会话主体 + canvas sidecar + 审计 sidecar 一起删
  const realSession = join(getSessionDir(), `verify-t13-${Date.now()}.jsonl`);
  try {
    mkdirSync(getSessionDir(), { recursive: true });
    writeFileSync(realSession, "");
    saveCanvas(realSession, [], []);
    setAuditSessionResolver(() => ({ sessionId: "sess-delete", sessionFile: realSession }));
    const delMgr = new PermissionManager();
    delMgr.onRequest((req) => delMgr.resolve(req.requestId, { decision: "allow" }));
    await delMgr.requestPermission(LOAD_CMD);
    delMgr.setAcceptAll(true);
    const auditFile = auditPathFor(realSession);
    const canvasFile = `${realSession}.canvas.json`;
    check("删除前会话 / canvas / 审计三个文件都在", existsSync(realSession) && existsSync(canvasFile) && existsSync(auditFile));
    check(
      "审计记录写进了会话自己的 sidecar",
      readPermissionAudit(realSession).length === 3 && readPermissionAudit(realSession).every((e) => e.sessionId === "sess-delete"),
      `actual=${readPermissionAudit(realSession).length}`,
    );
    deleteSession(realSession);
    check("deleteSession 一并删除审计 sidecar", !existsSync(auditFile));
    check("deleteSession 仍删除会话与 canvas sidecar", !existsSync(realSession) && !existsSync(canvasFile));
    check("审计 sidecar 不存在时删除返回 false（幂等）", deletePermissionAudit(realSession) === false);
  } finally {
    for (const f of [realSession, `${realSession}.canvas.json`, auditPathFor(realSession)]) {
      if (existsSync(f)) unlinkSync(f);
    }
  }

  // ── 7. 无会话归属时不阻断确认流 ────────────────────────────────────────
  console.log("\n[7] 会话尚未落盘时确认流不受影响（下面两行 warn 是预期输出）");
  {
    const before = readPermissionAudit(sessionFile).length;
    setAuditSessionResolver(() => null);
    const orphanMgr = new PermissionManager();
    const orphanPushed: PermissionRequest[] = [];
    orphanMgr.onRequest((req) => orphanPushed.push(req));
    const orphanPromise = orphanMgr.requestPermission(LOAD_CMD);
    orphanMgr.resolve(orphanPushed[0].requestId, { decision: "allow" });
    const orphanResult = await orphanPromise;
    check("拿不到会话文件时确认照常完成", orphanResult.decision === "allow" && orphanResult.decisionId === orphanPushed[0].requestId);
    check("拿不到会话文件时没有新增任何审计记录", readPermissionAudit(sessionFile).length === before);
    check(
      "直接写审计返回 null（不落盘、不抛错）",
      appendPermissionAudit({
        type: "permission_mode",
        at: new Date().toISOString(),
        decisionId: "pm-none",
        acceptAll: true,
        reason: "无会话",
        pendingAffected: 0,
      }) === null,
    );
  }

  // ── 8. 确认门触发条件（shouldAskPermission / readsDataContent 直接断言）────
  console.log("\n[8] 确认门触发条件（load -o 导出 + info 样本行读取）");
  {
    check("-o=xxx 触发确认门", shouldAskPermission("govio-cli observe load --name df_x --datasource sales -o=out.json --sql 'SELECT 1'") === true);
    check("--output xxx 触发确认门", shouldAskPermission("govio-cli observe load --name df_x --datasource sales --output out.json --sql 'SELECT 1'") === true);
    check("observe compare -o 不触发（只拦 observe load/info）", shouldAskPermission("govio-cli observe compare --source a --target b -o out.json") === false);
    check("SQL/路径文本里的 -o 不误判", shouldAskPermission(`govio-cli observe load --name df_x --datasource sales --sql "SELECT * FROM t WHERE p = '-o'"`) === false);
    check("不带 -o 的普通加载不触发", shouldAskPermission("govio-cli observe load --name df_x --datasource sales --sql 'SELECT 1' 2>&1") === false);
    check("-oxxx（短选项紧跟值）当前不触发（已知缺口，specs/10 已标注）", shouldAskPermission("govio-cli observe load --name df_x -oout.json --sql 'SELECT 1'") === false);

    // 读数据内容闸门（BUGFIX-permission-gate）：observe info 拉样本行也要过确认
    check("info --rows 5（拉样本行）触发确认门", shouldAskPermission("govio-cli observe info --name df_x --rows 5") === true);
    check("info --rows 10 触发确认门", shouldAskPermission("govio-cli observe info --name df_x --rows 10") === true);
    check("info 省略 --rows（CLI 默认 10 行样本）触发确认门", shouldAskPermission("govio-cli observe info --name df_x") === true);
    check("info --rows 0（仅结构）不触发", shouldAskPermission("govio-cli observe info --name df_x --rows 0") === false);
    check("info --rows=0（等号形式）不触发", shouldAskPermission("govio-cli observe info --name df_x --rows=0") === false);
    check("info --df（DataFrame 列表，仅元数据）不触发", shouldAskPermission("govio-cli observe info --df 2>&1") === false);
    check("info --datasource（数据源名列表，仅元数据）不触发", shouldAskPermission("govio-cli observe info --datasource 2>&1") === false);
    check("info 无 --name/--df/--datasource（help 等）不触发", shouldAskPermission("govio-cli observe info 2>&1") === false);
    check("info --rows abc（非法数值，保守当作读数据）触发确认门", shouldAskPermission("govio-cli observe info --name df_x --rows abc") === true);
    check("load -o 与 info 样本行都命中时 kinds 可区分", readsDataContent("govio-cli observe load --name df_x --datasource s -o out.json --sql 'SELECT 1'") === "load-output" && readsDataContent("govio-cli observe info --name df_x --rows 5") === "info-sample");
    check("普通加载不读数据内容", readsDataContent("govio-cli observe load --name df_x --datasource s --sql 'SELECT 1'") === null);
    check("observeInfoTarget 提取 df 名", observeInfoTarget("govio-cli observe info --name df_target --rows 5") === "df_target");
    check("observeInfoTarget 对非 info 命令返回 null", observeInfoTarget("govio-cli observe load --name df_x --datasource s --sql 'SELECT 1'") === null);
  }

  // ── 9. 条件放行（同 df 一次确认）+ P2 确认队列 ──────────────────────
  console.log("\n[9] 条件放行（同 df 一次确认）与确认队列");
  {
    permissionManager.clearAll();
    type Handler = (event: unknown, ctx: unknown) => unknown;
    const handlers2 = new Map<string, Handler>();
    const piStub2 = {
      registerTool: () => {},
      on: (name: string, handler: Handler) => { handlers2.set(name, handler); return () => {}; },
    };
    govioCanvasExtension(piStub2 as unknown as Parameters<typeof govioCanvasExtension>[0]);
    const toolCall2 = handlers2.get("tool_call");
    const toolResult2 = handlers2.get("tool_result");
    const piCtx2 = {
      sessionManager: { getSessionId: () => "sess-verify-cond" },
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    };
    const bashCall2 = (id: string, command: string) => ({ type: "tool_call", toolCallId: id, toolName: "bash", input: { command } });
    const bashResult2 = (id: string, command: string) => ({
      toolName: "bash",
      toolCallId: id,
      isError: false,
      input: { command },
      content: [{ type: "text", text: JSON.stringify({ success: true, rows: 3, columns: 1, column_info: [{ name: "id", dtype: "int64" }] }) }],
    });

    // 第一次 info 读样本：触发确认门（前端解 allow）
    const condRequests: PermissionRequest[] = [];
    const unsubCond = permissionManager.onRequest((req) => {
      condRequests.push(req);
      permissionManager.resolve(req.requestId, { decision: "allow" });
    });
    const infoCmd = 'govio-cli observe info --name df_cond --rows 5 2>&1';
    const first = await toolCall2?.(bashCall2("c1", infoCmd), piCtx2);
    check("同 df 首次样本读取触发确认门", first === undefined && condRequests.length === 1 && condRequests[0].command === infoCmd);
    await toolResult2?.(bashResult2("c1", infoCmd), piCtx2);
    check("命令执行后登记条件放行", permissionManager.isReadAccepted("df_cond") === true);

    // 同 df 第二次：不再触发确认（条件放行）
    const infoCmd2 = 'govio-cli observe info --name df_cond --rows 8 2>&1';
    const second = await toolCall2?.(bashCall2("c2", infoCmd2), piCtx2);
    check("同 df 后续样本读取免确认（方案 B）", second === undefined && condRequests.length === 1);

    // 不同 df：仍需确认
    const infoCmd3 = 'govio-cli observe info --name df_other --rows 5 2>&1';
    const third = await toolCall2?.(bashCall2("c3", infoCmd3), piCtx2);
    check("不同 df 的样本读取仍触发确认门", third === undefined && condRequests.length === 2 && condRequests[1].command === infoCmd3);
    await toolResult2?.(bashResult2("c3", infoCmd3), piCtx2);

    // 被拒绝的命令不产生豁免：再次读同 df 仍需确认
    unsubCond();
    permissionManager.clearAll(); // 清掉 df_cond/df_other 的放行登记
    const denyScript: PermissionDecisionInput[] = [{ decision: "deny", reason: "不给看" }];
    const unsubDeny = permissionManager.onRequest((req) => {
      const next = denyScript.shift();
      if (next) permissionManager.resolve(req.requestId, next);
    });
    const deniedCmd = 'govio-cli observe info --name df_deny --rows 5 2>&1';
    const denied = (await toolCall2?.(bashCall2("c4", deniedCmd), piCtx2)) as { block?: boolean } | undefined;
    check("被拒绝的样本读取被阻断", denied?.block === true);
    check("被拒绝的命令不产生条件放行豁免", permissionManager.isReadAccepted("df_deny") === false);
    unsubDeny();

    // clearAll 清空条件放行登记（会话切换不把豁免带过去）
    permissionManager.acceptRead("df_keep");
    check("acceptRead 登记后可查", permissionManager.isReadAccepted("df_keep") === true);
    permissionManager.clearAll();
    check("clearAll 清空条件放行登记（跨会话不继承豁免）", permissionManager.isReadAccepted("df_keep") === false);

    // -o 导出不受条件放行影响：同 df 反复导出仍逐次确认
    permissionManager.acceptRead("df_export");
    check("-o 导出命令不受 info 条件放行豁免", shouldAskPermission("govio-cli observe load --name df_export --datasource s -o out.json --sql 'SELECT 1'") === true);
  }
} finally {
  setAuditSessionResolver(null);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n共 ${checks} 项断言，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.error(`FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("PASS: 权限确认全程留痕，edit 记录改前改后命令，Manifest 可回查决策 ID");
