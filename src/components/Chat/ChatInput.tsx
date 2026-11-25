import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Send, Square, Database, Code, Table2, FileText, BarChart3, X } from "lucide-react";
import type { ReferencedNode, NodeType } from "../../types";
import { useCommands } from "../../commands/useCommands";
import { filterCommands, parseSlashCommand } from "../../commands/registry";
import CommandSuggestion from "../../commands/CommandSuggestion";
import type { SlashCommand, CommandContext } from "../../commands/types";

const NODE_ICONS: Record<NodeType, typeof Database> = {
  sourceTable: Database,
  sqlQuery: Code,
  dataFrame: Table2,
  report: FileText,
  chart: BarChart3,
};

const NODE_COLORS: Record<NodeType, string> = {
  sourceTable: "text-node-source",
  sqlQuery: "text-node-sql",
  dataFrame: "text-node-df",
  report: "text-node-report",
  chart: "text-node-chart",
};

interface ChatInputProps {
  onSend: (content: string) => void;
  onAbort: () => void;
  isStreaming: boolean;
  isConnected: boolean;
  needsConfig?: boolean;
  referencedNodes?: ReferencedNode[];
  onRemoveReference?: (nodeId: string) => void;
  clearMessages?: () => void;
  clearCanvas?: () => void;
  clearSession?: () => void;
  /**
   * 导入成功后刷新历史会话列表（T3.7）。
   *
   * 走**既有** WS 通道（`session_list`），所以不新增 WS 消息类型、不 bump `PROTOCOL_VERSION`；
   * 由 ChatPanel 把 `useChat().fetchSessions` 透下来。缺省（如 UI 测试里）为 no-op。
   */
  onSessionsChanged?: () => void;
}

/** `/export`、`/import` 的进度与结果反馈（一句话，与 CanvasToolbar 的导出提示同款形态与 TTL）。 */
interface CommandNote {
  kind: "ok" | "error";
  text: string;
}

const COMMAND_NOTE_TTL_MS = 8000;

export default function ChatInput({
  onSend,
  onAbort,
  isStreaming,
  isConnected,
  needsConfig = false,
  referencedNodes = [],
  onRemoveReference,
  clearMessages = () => {},
  clearCanvas = () => {},
  clearSession = () => {},
  onSessionsChanged = () => {},
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandNote, setCommandNote] = useState<CommandNote | null>(null);
  const commandNoteTimer = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const showCommandNote = useCallback((next: CommandNote) => {
    setCommandNote(next);
    if (commandNoteTimer.current !== null) window.clearTimeout(commandNoteTimer.current);
    commandNoteTimer.current = window.setTimeout(() => setCommandNote(null), COMMAND_NOTE_TTL_MS);
  }, []);

  useEffect(
    () => () => {
      if (commandNoteTimer.current !== null) window.clearTimeout(commandNoteTimer.current);
    },
    [],
  );

  /**
   * `/export`：打包当前会话为 zip（T3.6）。
   *
   * 内容全部由服务端会话文件 + 浏览器生成的交付报告组成（见 `commands/export-session.ts`），
   * 所以这里**不需要** messages/nodes/edges props —— 旧实现把画布 store 的实时状态塞进 JSON
   * 快照，新实现以会话 sidecar 为准，保证「包里的画布」与「包里的报告」说的是同一个东西。
   *
   * 实现模块用**动态 import**（与 CanvasToolbar 对 `export-report.ts` 的做法一致）：fflate、
   * HTML 报告模板、Plotly 静态渲染都不进主 bundle，只有用户真的执行 `/export` 才付这份代价。
   */
  const runExportBundle = useCallback(async () => {
    if (commandBusy) return;
    setCommandBusy(true);
    showCommandNote({ kind: "ok", text: "正在打包会话（画布 + 对话 + 留痕 + 交付报告）…" });
    try {
      const { exportSessionBundle } = await import("../../commands/export-session");
      const result = await exportSessionBundle({
        pageOrigin: window.location.origin,
        appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : undefined,
      });
      const kb = Math.max(1, Math.round(result.bytes / 1024));
      const parts = [
        `${kb} KB`,
        `${result.fileCount} 个文件`,
        result.reportIncluded ? "含交付报告" : "无交付报告（画布为空）",
      ];
      if (result.excludedParquet.count > 0) {
        parts.push(`未含 ${result.excludedParquet.count} 个 parquet（清单已记账）`);
      }
      // X27：把整包 sha256 原样显示（可选中复制）+ 旁文件名，交接时给接收方核对。
      showCommandNote({
        kind: "ok",
        text: `已导出 ${result.fileName}（${parts.join(" · ")}）\n整包 sha256：${result.bundleSha256}\n同时下载了 ${result.checksumFileName}；接收方可在 /import 后面带上该值强制比对`,
      });
    } catch (err) {
      showCommandNote({ kind: "error", text: `导出失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setCommandBusy(false);
    }
  }, [commandBusy, showCommandNote]);

  /**
   * `/import <bundle 路径>`（T3.7）：服务端读包 + 校验 + 落盘，本层只发请求与展示结果。
   *
   * 同样用**动态 import**：导入是低频操作，不该把它的代码与其错误码文案表塞进主 bundle。
   * 成功后调 `onSessionsChanged()` 让会话列表走既有 WS `session_list` 重拉一次。
   */
  const runImportBundle = useCallback(async (bundlePath: string, expectedSha256?: string) => {
    if (commandBusy) return;
    setCommandBusy(true);
    const withSum = expectedSha256 ? "（整包 sha256 已给出，将强制比对）" : "";
    showCommandNote({ kind: "ok", text: `正在校验并导入 ${bundlePath} …${withSum}` });
    try {
      const { importSessionBundle, describeImportResult } = await import("../../commands/import-session");
      const result = await importSessionBundle({ pageOrigin: window.location.origin, bundlePath, expectedSha256 });
      showCommandNote({ kind: "ok", text: describeImportResult(result) });
      onSessionsChanged();
    } catch (err) {
      showCommandNote({ kind: "error", text: `导入失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setCommandBusy(false);
    }
  }, [commandBusy, showCommandNote, onSessionsChanged]);

  const ctx: CommandContext = useMemo(
    () => ({
      clearMessages,
      clearCanvas,
      clearSession,
      exportSession: () => {
        void runExportBundle();
      },
      importSession: (bundlePath: string, expectedSha256?: string) => {
        void runImportBundle(bundlePath, expectedSha256);
      },
      addSystemMessage: () => {
        // System messages are visual-only; the store handles display
      },
    }),
    [clearMessages, clearCanvas, clearSession, runExportBundle, runImportBundle]
  );

  const { commands, execute } = useCommands(ctx);

  // pi 已加载的 skill，作为 /skill:name 建议项展示（session.prompt 原生展开该语法）
  const [skillCommands, setSkillCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d: { skills?: { name: string; description: string }[] }) =>
        setSkillCommands(
          (d.skills ?? []).map((s) => ({
            name: `skill:${s.name}`,
            description: s.description,
            category: "skill" as const,
            prompt: `/skill:${s.name} `,
          }))
        )
      )
      .catch(() => {});
  }, []);

  const allCommands = useMemo(() => [...commands, ...skillCommands], [commands, skillCommands]);

  const filteredCommands = useMemo(() => {
    if (!value.startsWith("/")) return [];
    return filterCommands(allCommands, value);
  }, [value, allCommands]);

  const updateValue = useCallback((newValue: string) => {
    setValue(newValue);
    const suggestions = newValue.startsWith("/") ? filterCommands(allCommands, newValue) : [];
    setShowSuggestions(suggestions.length > 0);
    setSelectedIndex(0);
  }, [allCommands]);

  const handleSelect = useCallback(
    (command: SlashCommand) => {
      if (command.category === "builtin" && command.args) {
        // 带参数的命令（T3.7 `/import`）：选中不立即执行，而是把命令行预填好等用户补参数
        // （与 skill 命令的 `prompt` 预填同款交互）。
        updateValue(`/${command.name} `);
        setShowSuggestions(false);
      } else if (command.category === "builtin") {
        execute(command);
        updateValue("");
      } else if (command.prompt) {
        updateValue(command.prompt);
      } else {
        setShowSuggestions(false);
      }
      textareaRef.current?.focus();
    },
    [execute, updateValue]
  );

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || !isConnected) return;
    // 带参数的内置命令（当前只有 `/import <path>`）在前端就地执行，不发给 agent：
    // 只认**声明了 args 的命令**，所以 `/export foo` 这类既有输入的行为逐字不变。
    const parsed = parseSlashCommand(trimmed, allCommands);
    if (parsed) {
      const placeholder = parsed.command.args?.placeholder ?? "参数";
      if (parsed.args === "") {
        showCommandNote({ kind: "error", text: `用法：/${parsed.command.name} <${placeholder}>` });
        updateValue(`/${parsed.command.name} `);
      } else {
        execute(parsed.command, parsed.args);
        updateValue("");
      }
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      return;
    }
    onSend(trimmed);
    updateValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, isConnected, onSend, updateValue, allCommands, execute, showCommandNote]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showSuggestions) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSelect(filteredCommands[selectedIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowSuggestions(false);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [showSuggestions, filteredCommands, selectedIndex, handleSelect, handleSend]
  );

  useEffect(() => {
    const onPrefill = (e: Event) => {
      setValue((e as CustomEvent<string>).detail);
      textareaRef.current?.focus();
    };
    window.addEventListener("govio:prefill-input", onPrefill);
    return () => window.removeEventListener("govio:prefill-input", onPrefill);
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [value]);

  return (
    <div className="flex flex-col gap-2 p-3 border-t border-border-subtle">
      {/* Reference chips */}
      {referencedNodes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {referencedNodes.map((ref) => {
            const Icon = NODE_ICONS[ref.type] || Database;
            return (
              <span
                key={ref.nodeId}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-bg-surface border border-border-default"
              >
                <Icon size={12} className={NODE_COLORS[ref.type] || "text-text-muted"} />
                <span className="text-text-primary">{ref.label}</span>
                {onRemoveReference && (
                  <button
                    onClick={() => onRemoveReference(ref.nodeId)}
                    className="ml-0.5 text-text-dim hover:text-text-primary transition-colors"
                  >
                    <X size={10} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* /export 与 /import 的进度与结果反馈（T3.6 / T3.7） */}
      {commandNote && (
        <div
          className={`px-2.5 py-1.5 rounded-md text-[11px] font-mono leading-relaxed break-all border bg-bg-card ${
            commandNote.kind === "error" ? "border-error/40 text-error" : "border-border-default text-text-muted"
          }`}
        >
          {commandNote.text}
        </div>
      )}

      {/* Input row with suggestion dropdown */}
      <div className="relative flex gap-2">
        <CommandSuggestion
          commands={filteredCommands}
          selectedIndex={selectedIndex}
          onSelect={handleSelect}
          onHover={setSelectedIndex}
        />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => updateValue(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // Delay closing so click events on suggestions can fire
            setTimeout(() => setShowSuggestions(false), 150);
          }}
          placeholder={
            needsConfig
              ? "请先配置 LLM Provider（右上角设置）"
              : !isConnected
                ? "未连接到服务器..."
                : isStreaming
                  ? "输入消息插队，立即修正 Agent 行为... (Enter 发送, Shift+Enter 换行)"
                  : "输入消息... (Enter 发送, Shift+Enter 换行)"
          }
          disabled={!isConnected || needsConfig}
          rows={1}
          className="flex-1 resize-none bg-bg-primary border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50 disabled:opacity-50"
        />
        {isStreaming && value.trim() ? (
          <button
            onClick={handleSend}
            disabled={!isConnected || needsConfig}
            className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-brand/20 border border-brand/40 text-brand hover:bg-brand/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="插队发送"
          >
            <Send size={14} />
          </button>
        ) : null}
        {isStreaming ? (
          <button
            onClick={onAbort}
            className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-error/20 border border-error/40 text-error hover:bg-error/30 transition-colors"
            title="停止"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim() || !isConnected || needsConfig}
            className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-brand/20 border border-brand/40 text-brand hover:bg-brand/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="发送"
          >
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
