import { describe, expect, it } from "vitest";
import { foldTurnProcess, foldHistoryMessages } from "../../src/utils/chat-fold";
import type { ChatMessage } from "../../src/hooks/useChat";

function asst(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "assistant", content: "", ...over };
}
function user(id: string, content: string): ChatMessage {
  return { id, role: "user", content };
}

const tool = (name: string) => ({ toolName: name, success: true });

describe("foldTurnProcess（一轮 thinking/tool 收拢为单条已处理消息）", () => {
  it("带正文消息的 tools/thinking 被剥离并合并进折叠消息", () => {
    const out = foldTurnProcess([
      asst("a1", { content: "我先查看 schema", tools: [tool("bash"), tool("read")] }),
      asst("a2", { thinking: "读 schema 再查图谱", tools: [tool("bash")] }),
      asst("a3", { content: "SMU 相关指标有 3 个" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(["a1-proc", "a1", "a3"]);
    const proc = out[0];
    expect(proc.folded).toBe(true);
    expect(proc.tools?.map((t) => t.toolName)).toEqual(["bash", "read", "bash"]);
    expect(proc.thinking).toBe("读 schema 再查图谱");
    // 正文消息只保留正文
    expect(out[1].tools).toBeUndefined();
    expect(out[1].content).toBe("我先查看 schema");
    expect(out[2].content).toBe("SMU 相关指标有 3 个");
  });

  it("折叠消息插在本轮第一条携带过程内容的消息位置", () => {
    const out = foldTurnProcess([
      asst("a1", { content: "开场白" }),
      asst("a2", { thinking: "t", tools: [tool("bash")] }),
    ]);
    expect(out.map((m) => m.id)).toEqual(["a1", "a2-proc"]);
    expect(out[1].folded).toBe(true);
  });

  it("多条 thinking 按顺序以空行拼接", () => {
    const out = foldTurnProcess([asst("a1", { thinking: "t1" }), asst("a2", { thinking: "t2" })]);
    expect(out).toHaveLength(1);
    expect(out[0].thinking).toBe("t1\n\nt2");
    expect(out[0].tools).toBeUndefined();
  });

  it("纯正文轮（无 thinking/tool）不产生折叠消息", () => {
    const out = foldTurnProcess([asst("a1", { content: "答案" })]);
    expect(out.map((m) => m.id)).toEqual(["a1"]);
    expect(out[0].folded).toBeUndefined();
  });

  it("正文消息已有的 folded 标记被清除（避免重复入组）", () => {
    const out = foldTurnProcess([asst("a1", { content: "答案", folded: true, thinking: "t" })]);
    expect(out.map((m) => [m.id, m.folded])).toEqual([
      ["a1-proc", true],
      ["a1", undefined],
    ]);
  });
});

describe("foldHistoryMessages（历史按 user 消息分轮收拢）", () => {
  it("两轮各自收拢为一个折叠消息，user 消息保留原位", () => {
    const out = foldHistoryMessages([
      user("u1", "问题1"),
      asst("a1", { tools: [tool("bash")], content: "答案1" }),
      user("u2", "问题2"),
      asst("a2", { thinking: "t" }),
      asst("a3", { content: "答案2" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1-proc", "a1", "u2", "a2-proc", "a3"]);
    expect(out[1].tools).toHaveLength(1);
    expect(out[4].thinking).toBe("t");
    expect(out[2].tools).toBeUndefined();
  });

  it("无过程内容的历史轮保持原样", () => {
    const msgs = [user("u1", "hi"), asst("a1", { content: "hello" })];
    expect(foldHistoryMessages(msgs)).toEqual(msgs);
  });
});
