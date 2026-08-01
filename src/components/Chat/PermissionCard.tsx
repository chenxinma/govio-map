import { useState } from "react";
import { ShieldAlert, Check, X, ShieldCheck, Pencil } from "lucide-react";
import type { PendingPermission, PermissionDecision } from "../../hooks/useChat";

interface PermissionCardProps {
  pending: PendingPermission;
  onRespond: (decision: PermissionDecision, editedCommand?: string) => void;
  onAcceptAll: () => void;
}

export default function PermissionCard({ pending, onRespond, onAcceptAll }: PermissionCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pending.command);

  return (
    <div className="mb-3 mx-auto max-w-[95%] rounded-lg border border-warning/40 border-l-2 border-l-warning bg-bg-primary px-3 py-2.5 text-sm">
      <div className="flex items-center gap-1.5 mb-2 text-warning">
        <ShieldAlert size={13} />
        <span className="text-xs font-medium">需要权限确认</span>
      </div>
      <p className="text-xs text-text-secondary mb-2">
        Agent 准备执行含 <code className="text-warning">-o</code> 的数据导出命令，请确认：
      </p>

      {!editing ? (
        <pre className="mb-2.5 max-h-32 overflow-auto rounded bg-bg-primary border border-border-subtle p-2 text-xs text-text-secondary whitespace-pre-wrap break-all">
          {pending.command}
        </pre>
      ) : (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          className="mb-2.5 w-full rounded bg-bg-primary border border-border-default p-2 text-xs text-text-primary font-mono resize-y focus:outline-none focus:border-brand"
        />
      )}

      {!editing ? (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => onRespond("allow")}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors"
          >
            <Check size={11} /> 允许
          </button>
          <button
            onClick={onAcceptAll}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-[#f0f0f0] border border-border-default text-text-secondary hover:border-brand/40 hover:text-brand transition-colors"
          >
            <ShieldCheck size={11} /> Accept All
          </button>
          <button
            onClick={() => { setDraft(pending.command); setEditing(true); }}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-[#f0f0f0] border border-border-default text-text-secondary hover:border-border-default hover:text-text-primary transition-colors"
          >
            <Pencil size={11} /> 编辑
          </button>
          <button
            onClick={() => onRespond("deny")}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-error/10 border border-error/40 text-error hover:bg-error/20 transition-colors"
          >
            <X size={11} /> 拒绝
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => { onRespond("edit", draft); }}
            disabled={!draft.trim() || draft.trim() === pending.command}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Check size={11} /> 执行修改后命令
          </button>
          <button
            onClick={() => setEditing(false)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-[#f0f0f0] border border-border-default text-text-secondary hover:text-text-primary transition-colors"
          >
            取消
          </button>
        </div>
      )}
    </div>
  );
}
