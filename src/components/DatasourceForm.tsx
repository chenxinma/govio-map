import { useState } from "react";
import { Eye, EyeOff, ShieldCheck, TestTube2 } from "lucide-react";
import { parseConnectArgs } from "../utils/connect-args";

/** 数据源表单值（密码独立字段，永不拼进 URL/聊天/日志） */
export interface DatasourceFormValues {
  name: string;
  url: string;
  password: string;
  /** connect-args 文本：每行 key=value */
  connectArgsText: string;
}

const INPUT_CLASS =
  "w-full h-9 bg-bg-primary border border-border-default rounded-md px-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50";

interface DatasourceFormProps {
  initialValues?: Partial<DatasourceFormValues>;
  submitLabel: string;
  /** 同名覆盖（编辑/更新既有数据源时预勾选） */
  defaultOverwrite?: boolean;
  busy?: boolean;
  onSubmit: (values: DatasourceFormValues, overwrite: boolean) => void;
  onTest?: (values: DatasourceFormValues) => void;
}

/**
 * X34 数据源凭据表单（秘密结构性路由的唯一合法凭据入口）。
 * 向导 Step3 与数据源管理器共用；密码掩码显隐 + 落盘位置/信任徽标常驻。
 */
export default function DatasourceForm({
  initialValues,
  submitLabel,
  defaultOverwrite,
  busy,
  onSubmit,
  onTest,
}: DatasourceFormProps) {
  const [name, setName] = useState(initialValues?.name ?? "");
  const [url, setUrl] = useState(initialValues?.url ?? "");
  const [password, setPassword] = useState(initialValues?.password ?? "");
  const [connectArgsText, setConnectArgsText] = useState(initialValues?.connectArgsText ?? "");
  const [overwrite, setOverwrite] = useState(!!defaultOverwrite);
  const [showPassword, setShowPassword] = useState(false);

  const argsParsed = parseConnectArgs(connectArgsText);
  const canSubmit = !!name.trim() && !!url.trim() && argsParsed !== null && !busy;

  const values = (): DatasourceFormValues => ({ name: name.trim(), url: url.trim(), password, connectArgsText });

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-muted">名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="sales"
          className={INPUT_CLASS}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-muted">URL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="duckdb:///D:/data/sales.duckdb 或 mysql+pymysql://user@host:3306/db"
          className={INPUT_CLASS}
        />
        <span className="text-[11px] text-text-dim">
          账号写在 URL 的 user@host 段；密码单独填在下方（不要写进 URL）
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-muted">密码</label>
        <div className="relative">
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="仅加密存本机，不发往大模型"
            className={`${INPUT_CLASS} pr-9`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
            title={showPassword ? "隐藏密码" : "显示密码"}
          >
            {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-muted">连接参数（可选，每行 key=value）</label>
        <textarea
          value={connectArgsText}
          onChange={(e) => setConnectArgsText(e.target.value)}
          placeholder={"timeout=30\ncharset=utf8mb4"}
          rows={2}
          className="w-full bg-bg-primary border border-border-default rounded-md px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50"
        />
        {argsParsed === null && (
          <span className="text-xs text-error">每行需为 key=value 格式</span>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(e) => setOverwrite(e.target.checked)}
          className="accent-brand"
        />
        同名时覆盖更新
      </label>

      <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
        <ShieldCheck size={12} className="text-brand" />
        <span>凭据仅加密存于本机 ~/.govio/config.yaml（密码加密），不发往大模型</span>
      </div>

      <div className="flex gap-2">
        {onTest && (
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onTest(values())}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-bg-surface border border-border-default text-text-secondary hover:text-text-primary hover:border-brand/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <TestTube2 size={13} /> 测试连接
          </button>
        )}
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => onSubmit(values(), overwrite)}
          className="px-3 py-1.5 rounded text-sm bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
