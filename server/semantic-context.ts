/**
 * T2.2 语义引用归因：把「本会话最近一次注入的图谱实体」暂存在内存（sessionId 为 key），
 * 供 govio-canvas 的 message_end 建 sqlQuery 节点时写入 semanticRefs（口径溯源）。
 *
 * 生命周期与 currentReferencedNodes（govio-node-queue）一致：makePrompt 组装注入时
 * 写入，本轮 prompt 结束（ws-handler 的 finally）清除。steer/followUp 不走注入、
 * 从不写入 → 其产出的 SQL 节点自然没有 semanticRefs（缺失不写键，禁止猜测补全）。
 *
 * 取舍：内存 map 而非落 jsonl 再读——prompt → message_end 一对一（见
 * docs/tasks/T2.2-semantic-lineage/design.md），无需持久化中间态；留痕已有
 * `<session>.injection.jsonl`（T2.1）承担审计职责。
 */
import type { SemanticRef } from "../src/types/semantic.js";

const refsBySession = new Map<string, SemanticRef[]>();
/** 口径检测目标指标（问题点名指标）与 semanticRefs 同生命周期，但范围更窄（T2.3 误报修复） */
const caliberBySession = new Map<string, string[]>();

/** GraphEntity → SemanticRef（code/name 缺失即省略键；空输入返回空数组） */
export function toSemanticRefs(
  entities: ReadonlyArray<Pick<SemanticRef, "entityType" | "id" | "code" | "name">>,
): SemanticRef[] {
  return entities.map((e) => ({
    entityType: e.entityType,
    id: e.id,
    ...(e.code !== undefined ? { code: e.code } : {}),
    ...(e.name !== undefined ? { name: e.name } : {}),
  }));
}

/** 记录本轮注入上下文；sessionId 为空或 refs 为空时清除（无可归因内容） */
export function setSessionSemanticRefs(sessionId: string, refs: SemanticRef[]): void {
  if (!sessionId) return;
  if (refs.length === 0) {
    refsBySession.delete(sessionId);
    return;
  }
  refsBySession.set(sessionId, refs);
}

/** 取本会话最近一次注入的图谱实体；无归因返回 undefined（调用方不写键） */
export function getSessionSemanticRefs(sessionId: string): SemanticRef[] | undefined {
  if (!sessionId) return undefined;
  return refsBySession.get(sessionId);
}

/** 记录本轮口径检测目标指标（问题点名）。
 * 置空数组也**保留条目**（区别于 undefined）：undefined 表示「本轮未注入」，
 * 调用方据此决定是否回退，不能把「明确无点名」误当成「不知道」。
 */
export function setSessionCaliberMetrics(sessionId: string, metrics: string[]): void {
  if (!sessionId) return;
  caliberBySession.set(sessionId, [...metrics]);
}

/** 取本会话最近一次注入中点名的指标；无则 undefined（调用方不做口径检测） */
export function getSessionCaliberMetrics(sessionId: string): string[] | undefined {
  if (!sessionId) return undefined;
  return caliberBySession.get(sessionId);
}

/** 本轮 prompt 结束后清除（steer/followUp 之后的 message_end 不得串到上一轮的口径） */
export function clearSessionSemanticRefs(sessionId: string): void {
  if (!sessionId) return;
  refsBySession.delete(sessionId);
  caliberBySession.delete(sessionId);
}
