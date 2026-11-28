import { useEffect, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Database,
  RefreshCw,
  Table2,
  Plus,
  Check,
  Upload,
  Pencil,
  Trash2,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { useChatContext } from "../hooks/useChatContext";
import type { ObserveInfo, DataFrameSummary, OnboardingOutcome } from "../hooks/useChat";
import type { WSOnboardingStatus } from "../types/ws-protocol";
import { useCanvasStore } from "../store/canvas-store";
import DatasourceForm, { type DatasourceFormValues } from "./DatasourceForm";
import { parseConnectArgs } from "../utils/connect-args";

interface DataSourcesModalProps {
  onClose: () => void;
}

function estimateMemoryUsage(rows: number, cols: number): string {
  const bytes = rows * cols * 8;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function OutcomeBanner({ outcome, successText }: { outcome: OnboardingOutcome; successText?: string }) {
  if (outcome.ok) {
    return (
      <div className="text-xs text-brand border border-brand/40 bg-brand/10 rounded-md px-3 py-2">
        {successText ?? "成功"}
      </div>
    );
  }
  return (
    <div className="text-xs border border-error/40 bg-error/10 rounded-md px-3 py-2 space-y-1">
      <div className="text-error">{outcome.error ?? "操作失败"}</div>
      {outcome.hint && <div className="text-text-secondary">{outcome.hint}</div>}
    </div>
  );
}

/**
 * X34 数据源管理器（原只读列表升级）：增删改（add_datasource/remove_datasource）+
 * 测试连接 + 一键导元数据（import_metadata）+ 落盘位置展示。
 * 「导入元数据」预填回灌聊天框的路径已删除（秘密结构性路由：凭据与数据源操作不进聊天）。
 */
export default function DataSourcesModal({ onClose }: DataSourcesModalProps) {
  const { observeInfo, onboardingAction } = useChatContext();

  const [info, setInfo] = useState<ObserveInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<WSOnboardingStatus | null>(null);

  // 新增 / 编辑（编辑 = 同名覆盖更新；凭据不回显，需重新输入）
  const [formOpen, setFormOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [saveOutcome, setSaveOutcome] = useState<OnboardingOutcome | null>(null);
  const [testOutcome, setTestOutcome] = useState<OnboardingOutcome | null>(null);
  const [rowAction, setRowAction] = useState<{ name: string; kind: "delete" } | null>(null);

  // 一键导元数据（import_metadata，仅 DuckDB；长耗时带进度）
  const [importFor, setImportFor] = useState<string | null>(null);
  const [importSchemas, setImportSchemas] = useState("main");
  const [importBusy, setImportBusy] = useState(false);
  const [importProgress, setImportProgress] = useState<string[]>([]);
  const [importOutcome, setImportOutcome] = useState<OnboardingOutcome | null>(null);

  const nodes = useCanvasStore((s) => s.nodes);
  const createGovioNode = useCanvasStore((s) => s.createGovioNode);

  const dfNamesOnCanvas = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) {
      const d = n.data as unknown as { type?: string; dfName?: string };
      if (d.type === "dataFrame" && d.dfName) set.add(d.dfName);
    }
    return set;
  }, [nodes]);

  const handleAddToCanvas = useCallback(
    (df: DataFrameSummary) => {
      if (dfNamesOnCanvas.has(df.name)) return;
      const columns = (df.column_info ?? []).map((c) => ({
        name: c.name,
        nonNull: df.rows,
        dtype: c.dtype,
      }));
      createGovioNode({
        type: "govio_node_create",
        nodeType: "dataFrame",
        title: `DF: ${df.name}`,
        dfName: df.name,
        sourceName: "",
        totalRows: df.rows,
        totalColumns: df.columns,
        memoryUsage: estimateMemoryUsage(df.rows, df.columns),
        columns,
      });
    },
    [dfNamesOnCanvas, createGovioNode]
  );

  // 状态写入放 promise 回调（react-hooks/set-state-in-effect：effect 链路内无同步 setState）
  const refreshStatus = useCallback(
    () =>
      onboardingAction({ action: "status" }).then((out) => {
        if (out.ok && out.data) setStatus(out.data as WSOnboardingStatus);
      }),
    [onboardingAction]
  );

  const fetchInfo = useCallback(() => {
    return observeInfo()
      .then(setInfo)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [observeInfo]);

  useEffect(() => {
    fetchInfo();
    void refreshStatus();
  }, [fetchInfo, refreshStatus]);

  const handleRefresh = () => {
    setLoading(true);
    setError(null);
    fetchInfo();
    void refreshStatus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const openAddForm = () => {
    setEditingName(null);
    setSaveOutcome(null);
    setTestOutcome(null);
    setFormOpen(true);
  };

  const openEditForm = (name: string) => {
    setEditingName(name);
    setSaveOutcome(null);
    setTestOutcome(null);
    setFormOpen(true);
  };

  const handleTest = async (values: DatasourceFormValues) => {
    setFormBusy(true);
    setTestOutcome(null);
    const out = await onboardingAction({
      action: "test_datasource",
      datasource: { url: values.url, password: values.password || undefined, connectArgs: parseConnectArgs(values.connectArgsText) ?? {} },
    });
    setTestOutcome(out);
    setFormBusy(false);
  };

  const handleSave = async (values: DatasourceFormValues, overwrite: boolean) => {
    setFormBusy(true);
    setSaveOutcome(null);
    const out = await onboardingAction({
      action: "add_datasource",
      datasource: {
        name: values.name,
        url: values.url,
        password: values.password || undefined,
        connectArgs: parseConnectArgs(values.connectArgsText) ?? {},
        // 编辑即同名覆盖更新（update 语义：单次 ConfigManager.save，无中间态）
        overwrite: overwrite || editingName !== null,
      },
    });
    setSaveOutcome(out);
    setFormBusy(false);
    if (out.ok) {
      setFormOpen(false);
      void refreshStatus();
    }
  };

  const handleDelete = async (name: string) => {
    setRowAction({ name, kind: "delete" });
    const out = await onboardingAction({ action: "remove_datasource", name });
    setRowAction(null);
    setSaveOutcome(out);
    if (out.ok) void refreshStatus();
  };

  const handleImport = async () => {
    if (!importFor) return;
    setImportBusy(true);
    setImportOutcome(null);
    setImportProgress([]);
    const out = await onboardingAction(
      { action: "import_metadata", datasource: importFor, schemas: importSchemas.trim() || "main", mode: "update" },
      (m) => setImportProgress((prev) => [...prev.slice(-4), m])
    );
    setImportOutcome(out);
    setImportBusy(false);
    if (out.ok) void refreshStatus();
  };

  const datasources = status?.datasources ?? [];
  const dataframes = info?.dataframes?.dataframes ?? [];

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border-default rounded-lg w-[620px] max-w-[92vw] max-h-[90vh] flex flex-col shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-brand" />
            <span className="text-sm font-medium text-text-primary">数据源管理器</span>
            <span className="inline-flex items-center gap-1 text-[10px] text-text-muted border border-border-subtle rounded px-1.5 py-0.5">
              <ShieldCheck size={10} className="text-brand" />
              凭据仅加密存本机、不发往大模型
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface disabled:opacity-40"
              title="刷新"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {error && (
            <div className="text-sm text-error border border-error/40 bg-error/10 rounded-md px-3 py-2">
              加载失败: {error}
            </div>
          )}
          {saveOutcome && <OutcomeBanner outcome={saveOutcome} successText="数据源已保存（凭据加密落盘）" />}

          {/* 已配置数据源（管理：增删改 + 测试 + 一键导元数据） */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted">已配置数据源（{datasources.length}）</span>
              <button
                type="button"
                onClick={openAddForm}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-bg-surface text-text-secondary hover:text-text-primary hover:border-brand/40 border border-border-default transition-colors"
              >
                <Plus size={12} /> 新增数据源
              </button>
            </div>
            {loading && !info && !status ? (
              <div className="text-sm text-text-dim">加载中...</div>
            ) : datasources.length === 0 ? (
              <div className="text-sm text-text-dim">暂无已配置数据源，点击「新增数据源」开始</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {datasources.map((ds) => (
                  <div
                    key={ds}
                    className="flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-md text-sm bg-bg-surface border border-border-default text-text-primary"
                  >
                    <Database size={12} className="text-brand" />
                    <span className="flex-1 truncate">{ds}</span>
                    <button
                      onClick={() => {
                        setImportFor(importFor === ds ? null : ds);
                        setImportOutcome(null);
                        setImportProgress([]);
                      }}
                      className="inline-flex items-center gap-1 text-text-muted hover:text-brand transition-colors px-1.5 py-1 rounded hover:bg-brand/10"
                      title="一键导入元数据到知识图谱（DuckDB）"
                    >
                      <Upload size={13} /> 元数据
                    </button>
                    <button
                      onClick={() => openEditForm(ds)}
                      className="inline-flex items-center text-text-muted hover:text-brand transition-colors p-1 rounded hover:bg-brand/10"
                      title="编辑（同名覆盖更新）"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => void handleDelete(ds)}
                      disabled={rowAction?.name === ds}
                      className="inline-flex items-center text-text-muted hover:text-error transition-colors p-1 rounded hover:bg-error/10 disabled:opacity-40"
                      title="删除"
                    >
                      {rowAction?.name === ds ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 一键导元数据面板 */}
            {importFor && (
              <div className="border border-border-subtle rounded-md p-3 space-y-2">
                <div className="text-xs text-text-secondary">
                  导入「{importFor}」的元数据到知识图谱（目前仅 DuckDB 数据源支持一键；其它类型会给出引导）
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={importSchemas}
                    onChange={(e) => setImportSchemas(e.target.value)}
                    placeholder="schemas，如 main"
                    className="flex-1 h-8 bg-bg-primary border border-border-default rounded-md px-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50"
                  />
                  <button
                    type="button"
                    onClick={() => void handleImport()}
                    disabled={importBusy}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors disabled:opacity-40"
                  >
                    {importBusy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} 开始导入
                  </button>
                </div>
                {importProgress.length > 0 && (
                  <div className="space-y-0.5">
                    {importProgress.map((line, i) => (
                      <div key={i} className="text-[10px] text-text-muted font-mono">{line}</div>
                    ))}
                  </div>
                )}
                {importOutcome && <OutcomeBanner outcome={importOutcome} successText="元数据已导入知识图谱" />}
              </div>
            )}
          </div>

          {/* 新增 / 编辑表单（凭据唯一合法入口） */}
          {formOpen && (
            <div className="border border-border-subtle rounded-md p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">
                  {editingName ? `编辑数据源「${editingName}」（同名覆盖，凭据需重新输入）` : "新增数据源"}
                </span>
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="text-text-muted hover:text-text-primary p-1 rounded hover:bg-bg-surface"
                >
                  <X size={13} />
                </button>
              </div>
              <DatasourceForm
                key={editingName ?? "new"}
                initialValues={{ name: editingName ?? "" }}
                defaultOverwrite={editingName !== null}
                submitLabel="保存数据源"
                busy={formBusy}
                onSubmit={(values, overwrite) => void handleSave(values, overwrite)}
                onTest={(values) => void handleTest(values)}
              />
              {testOutcome && (
                <OutcomeBanner
                  outcome={testOutcome}
                  successText={`连接成功${typeof (testOutcome.data as { latencyMs?: number } | undefined)?.latencyMs === "number" ? `（${(testOutcome.data as { latencyMs: number }).latencyMs}ms）` : ""}`}
                />
              )}
            </div>
          )}

          {/* 已加载 DataFrame（保留原只读列表 + 添加到画布） */}
          <div className="space-y-2">
            <span className="text-xs text-text-muted">已加载 DataFrame（{dataframes.length}）</span>
            {dataframes.length === 0 ? (
              <div className="text-sm text-text-dim">暂无已加载的 DataFrame</div>
            ) : (
              <div className="border border-border-subtle rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-bg-surface text-text-muted text-xs">
                      <th className="text-left px-3 py-2 font-medium">名称</th>
                      <th className="text-right px-3 py-2 font-medium">行数</th>
                      <th className="text-right px-3 py-2 font-medium">列数</th>
                      <th className="text-right px-3 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {dataframes.map((df) => (
                      <tr key={df.name} className="border-t border-border-subtle">
                        <td className="px-3 py-2 text-text-primary">
                          <span className="inline-flex items-center gap-1.5">
                            <Table2 size={12} className="text-node-df" />
                            {df.name}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-text-secondary font-mono">
                          {df.rows.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right text-text-secondary font-mono">{df.columns}</td>
                        <td className="px-3 py-2 text-right">
                          {dfNamesOnCanvas.has(df.name) ? (
                            <span
                              className="inline-flex items-center text-text-dim"
                              title="已在画布"
                            >
                              <Check size={14} />
                            </span>
                          ) : (
                            <button
                              onClick={() => handleAddToCanvas(df)}
                              className="inline-flex items-center text-text-muted hover:text-brand transition-colors p-1 rounded hover:bg-brand/10"
                              title="添加到画布"
                            >
                              <Plus size={14} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
            <ShieldCheck size={11} className="text-brand" />
            <span>配置落盘：~/.govio/config.yaml（密码加密）；测试连接只探测不落盘</span>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
