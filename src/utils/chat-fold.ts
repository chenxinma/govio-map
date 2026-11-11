/**
 * 一轮对话的过程消息收拢（「已处理」组）：
 * 把一轮内所有 assistant 消息的 thinking/tool（含带正文消息附着的）合并为
 * 一条折叠过程消息，插在本轮第一条 assistant 消息的位置；正文消息只保留正文。
 * agent_end（运行态）与 session_messages_result（历史加载）共用，保证恢复后一致。
 */
import type { ChatMessage, ToolCall } from "../hooks/useChat";

/** 收拢一轮（消息列表以本轮第一条 assistant 消息开头）的 thinking/tool */
export function foldTurnProcess(msgs: ChatMessage[]): ChatMessage[] {
  const thinking: string[] = [];
  const tools: ToolCall[] = [];
  const out: ChatMessage[] = [];
  // 折叠消息插入点：本轮第一条携带 thinking/tool 的 assistant 消息的原位置
  let procIdx = -1;
  let procBaseId = "";
  for (const m of msgs) {
    if (m.role !== "assistant") {
      out.push(m);
      continue;
    }
    const hasProc = !!m.thinking || !!(m.tools && m.tools.length > 0);
    const hasContent = !!(m.content && m.content.trim());
    if (hasProc) {
      if (procIdx === -1) {
        procIdx = out.length;
        procBaseId = m.id;
      }
      if (m.thinking) thinking.push(m.thinking);
      if (m.tools) tools.push(...m.tools);
    }
    // 无正文的过程消息被折叠消息吸收，不再单独保留
    if (hasContent) out.push({ ...m, thinking: undefined, tools: undefined, folded: undefined });
  }
  if (procIdx === -1) return out;
  out.splice(procIdx, 0, {
    id: `${procBaseId}-proc`,
    role: "assistant",
    content: "",
    thinking: thinking.length > 0 ? thinking.join("\n\n") : undefined,
    tools: tools.length > 0 ? tools : undefined,
    folded: true,
  });
  return out;
}

/**
 * 历史消息按轮收拢：user 消息作为轮分隔（steering 插队会把一轮切成两组，
 * shortcut: 历史数据没有轮边界标记，用 user 消息近似）。
 */
export function foldHistoryMessages(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let turn: ChatMessage[] = [];
  const flush = () => {
    if (turn.length > 0) {
      out.push(...foldTurnProcess(turn));
      turn = [];
    }
  };
  for (const m of msgs) {
    if (m.role === "user") {
      flush();
      out.push(m);
    } else {
      turn.push(m);
    }
  }
  flush();
  return out;
}
