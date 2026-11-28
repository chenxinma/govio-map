import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Compass,
  Check,
  Circle,
  Loader2,
  ShieldCheck,
  RefreshCw,
  Terminal,
  Database,
  Network,
  ChevronDown,
  ChevronRight,
  Rocket,
  Eye,
  EyeOff,
} from "lucide-react";
import { useChatContext } from "../hooks/useChatContext";
import type { OnboardingOutcome } from "../hooks/useChat";
import type { WSOnboardingStatus } from "../types/ws-protocol";
import type { ModelsConfig, ProviderConfig } from "../types/models-config";
import { PROVIDER_PRESETS, type ProviderPreset } from "../utils/provider-presets";
import DatasourceForm, { type DatasourceFormValues } from "./DatasourceForm";
import { parseConnectArgs } from "../utils/connect-args";

const INPUT_CLASS =
  "w-full h-9 bg-bg-primary border border-border-default rounded-md px-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50";

const STEP_LABELS = ["环境自检", "LLM 配置", "图谱初始化", "数据源"];

/** 各步完成态（幂等：已就绪的步骤如实展示，不覆盖不破坏） */
function isStepDone(step: number, status: WSOnboardingStatus | null, flags: { envOk: boolean; llmSaved: boolean; dsSkipped: boolean }): boolean {
  switch (step) {
    case 0:
      return flags.envOk || (!!status?.cli.installed && !!status?.skillsReady);
    case 1:
      return flags.llmSaved || !!status?.modelsConfigured;
    case 2:
      return !!status?.graph.initialized;
    case 3:
      return flags.dsSkipped || (status?.datasources.length ?? 0) > 0;
    default:
      return false;
  }
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

interface OnboardingWizardProps {
  onClose: () => void;
}

/**
 * X34 首启向导（单一 stepper：环境自检 → LLM → 图谱 → 数据源 → 完成态）。
 *
 * 幂等可续做（R4/G6）：进入先查 onboarding status，每步显示真实状态、不覆盖不破坏；
 * 每步即时验证（测试模型 / 测试连接）；数据源可跳过延后。
 * 凭据纪律（R2）：apiKey / 数据源密码只经 WS 表单通道去后端子进程，不进 LLM/日志。
 */
export default function OnboardingWizard({ onClose }: OnboardingWizardProps) {
  const { onboardingAction, fetchModelsConfig, saveModelsConfig } = useChatContext();

  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<WSOnboardingStatus | null>(null);

  // Step0 环境自检
  const [envRunning, setEnvRunning] = useState(false);
  const [envProgress, setEnvProgress] = useState<string[]>([]);
  const [envOutcome, setEnvOutcome] = useState<OnboardingOutcome | null>(null);

  // Step1 LLM（R7：无默认供应商，必须主动选一个预置或自定义）
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmOutcome, setLlmOutcome] = useState<OnboardingOutcome | null>(null);
  const [llmSaved, setLlmSaved] = useState(false);
  const [savedSummary, setSavedSummary] = useState<string[]>([]);

  // Step2 图谱（默认 ladybug 一键；falkordb/networkx 只收参）
  const [graphBackend, setGraphBackend] = useState<"ladybug" | "falkordb" | "networkx">("ladybug");
  const [showAdvancedGraph, setShowAdvancedGraph] = useState(false);
  const [falkorHost, setFalkorHost] = useState("");
  const [falkorPort, setFalkorPort] = useState("");
  const [falkorGraph, setFalkorGraph] = useState("");
  const [gmlPath, setGmlPath] = useState("");
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphOutcome, setGraphOutcome] = useState<OnboardingOutcome | null>(null);

  // Step3 数据源（可跳过/延后）
  const [dsBusy, setDsBusy] = useState(false);
  const [dsTestOutcome, setDsTestOutcome] = useState<OnboardingOutcome | null>(null);
  const [dsSaveOutcome, setDsSaveOutcome] = useState<OnboardingOutcome | null>(null);
  const [dsSkipped, setDsSkipped] = useState(false);

  // 状态写入全部放 promise 回调（满足 react-hooks/set-state-in-effect：effect 链路内无同步 setState）
  const refreshStatus = useCallback(
    () =>
      onboardingAction({ action: "status" }).then((out) => {
        if (out.ok && out.data) setStatus(out.data as WSOnboardingStatus);
      }),
    [onboardingAction]
  );

  const runEnvCheck = useCallback(
    () =>
      Promise.resolve()
        .then(() => {
          setEnvRunning(true);
          setEnvOutcome(null);
          setEnvProgress([]);
          return onboardingAction({ action: "env_check" }, (m) =>
            setEnvProgress((prev) => [...prev.slice(-5), m])
          );
        })
        .then((out) => {
          setEnvOutcome(out);
          setEnvRunning(false);
          return refreshStatus();
        }),
    [onboardingAction, refreshStatus]
  );

  // 进入向导：先查真实状态（幂等入口），再自动跑一次环境自检（缺则带进度自动修复）
  useEffect(() => {
    void refreshStatus();
    void runEnvCheck();
    void fetchModelsConfig()
      .then((cfg) => {
        setSavedSummary(
          Object.entries(cfg.providers ?? {}).map(
            ([name, p]) => `${name} / ${(p.models ?? []).map((m) => m.id).filter(Boolean).join(", ") || "（无模型）"}`
          )
        );
      })
      .catch(() => setSavedSummary([]));
  }, [refreshStatus, runEnvCheck, fetchModelsConfig]);

  const choosePreset = (p: ProviderPreset) => {
    setPreset(p);
    setProviderName(p.providerName);
    setBaseUrl(p.baseUrl);
    setApi(p.api);
    setApiKey("");
    setModelId("");
    setLlmOutcome(null);
  };

  // 「保存并测试」（design.md 遗留 9 裁决）：先走 save_models_config 写盘，
  // 落盘 + 会话重启完成后再 test_model；apiKey 只进表单 → 后端落盘通道。
  const handleSaveAndTest = async () => {
    setLlmBusy(true);
    setLlmOutcome(null);
    try {
      const existing = await fetchModelsConfig().catch(() => ({ providers: {} }) as ModelsConfig);
      const merged: Record<string, ProviderConfig> = {
        ...existing.providers,
        [providerName.trim()]: {
          baseUrl: baseUrl.trim(),
          api: api.trim(),
          apiKey,
          models: [{ id: modelId.trim() }],
        },
      };
      await saveModelsConfig({ providers: merged });
      setLlmSaved(true);
      setSavedSummary(Object.entries(merged).map(([n, p]) => `${n} / ${p.models.map((m) => m.id).join(", ")}`));
      void refreshStatus();
      const out = await onboardingAction({ action: "test_model", provider: providerName.trim(), modelId: modelId.trim() });
      setLlmOutcome(out);
    } catch (err) {
      setLlmOutcome({ ok: false, error: err instanceof Error ? err.message : String(err), hint: "请检查网络与配置后重试" });
    } finally {
      setLlmBusy(false);
    }
  };

  const handleInitGraph = async () => {
    setGraphBusy(true);
    setGraphOutcome(null);
    const config =
      graphBackend === "ladybug"
        ? { backend: "ladybug" as const }
        : graphBackend === "falkordb"
          ? { backend: "falkordb" as const, host: falkorHost.trim() || undefined, port: falkorPort.trim() || undefined, graphName: falkorGraph.trim() || undefined }
          : { backend: "networkx" as const, gmlPath: gmlPath.trim() };
    const out = await onboardingAction({ action: "init_graph", config });
    setGraphOutcome(out);
    setGraphBusy(false);
    void refreshStatus();
  };

  const handleTestDatasource = async (values: DatasourceFormValues) => {
    setDsBusy(true);
    setDsTestOutcome(null);
    const connectArgs = parseConnectArgs(values.connectArgsText) ?? {};
    const out = await onboardingAction({
      action: "test_datasource",
      datasource: { url: values.url, password: values.password || undefined, connectArgs },
    });
    setDsTestOutcome(out);
    setDsBusy(false);
  };

  const handleSaveDatasource = async (values: DatasourceFormValues, overwrite: boolean) => {
    setDsBusy(true);
    setDsSaveOutcome(null);
    const connectArgs = parseConnectArgs(values.connectArgsText) ?? {};
    const out = await onboardingAction({
      action: "add_datasource",
      datasource: {
        name: values.name,
        url: values.url,
        password: values.password || undefined,
        connectArgs,
        overwrite,
      },
    });
    setDsSaveOutcome(out);
    setDsBusy(false);
    if (out.ok) setDsSkipped(false);
    void refreshStatus();
  };

  const doneFlags = { envOk: envOutcome?.ok === true, llmSaved, dsSkipped };
  const envData = envOutcome?.ok ? (envOutcome.data as { cliVersion: string | null; skillsReady: boolean }) : null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-bg-card border border-border-default rounded-lg w-[680px] max-w-[94vw] max-h-[92vh] flex flex-col shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + 信任徽标（R2/R6） */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2">
            <Compass size={16} className="text-brand" />
            <span className="text-sm font-medium text-text-primary">初始向导</span>
            <span className="inline-flex items-center gap-1 text-[10px] text-text-muted border border-border-subtle rounded px-1.5 py-0.5">
              <ShieldCheck size={10} className="text-brand" />
              凭据仅加密存本机、不发往大模型
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface"
            title="关闭向导（可从顶栏「初始向导」再次打开，进度不会丢失）"
          >
            <X size={16} />
          </button>
        </div>

        {/* stepper */}
        <div className="flex items-center gap-1 px-4 py-2.5 border-b border-border-subtle flex-shrink-0">
          {STEP_LABELS.map((label, i) => {
            const done = isStepDone(i, status, doneFlags);
            return (
              <button
                key={label}
                type="button"
                onClick={() => setStep(i)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${
                  step === i ? "bg-brand/15 text-brand border border-brand/40" : "text-text-secondary hover:bg-bg-surface border border-transparent"
                }`}
              >
                {done ? <Check size={12} className="text-brand" /> : <Circle size={12} />}
                {label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setStep(4)}
            className={`ml-auto px-2.5 py-1 rounded text-xs transition-colors ${
              step === 4 ? "bg-brand/15 text-brand border border-brand/40" : "text-text-secondary hover:bg-bg-surface border border-transparent"
            }`}
          >
            完成
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* ── Step0 环境自检 ─────────────────────────────────────────── */}
          {step === 0 && (
            <div className="space-y-3">
              <div className="text-sm text-text-primary font-medium">环境自检</div>
              <p className="text-xs text-text-secondary">
                自动检查并修复 govio-cli（最低版本由安装器强制）与 govio 技能包；缺失项会带进度自动补齐。
              </p>
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <Terminal size={13} className="text-brand" />
                {status?.cli.installed ? (
                  <span>
                    govio-cli v{status.cli.version ?? "未知"}
                    {envOutcome?.ok ? "（已满足最低版本要求，达标）" : ""}
                  </span>
                ) : (
                  <span>govio-cli 未检测到</span>
                )}
                <span className="text-text-dim">·</span>
                <span>技能包：{status?.skillsReady ? "已就绪" : "未就绪"}</span>
              </div>
              {envProgress.length > 0 && (
                <div className="rounded-md border border-border-subtle bg-bg-surface px-3 py-2 space-y-1">
                  {envProgress.map((line, i) => (
                    <div key={i} className="text-[11px] text-text-muted font-mono">{line}</div>
                  ))}
                </div>
              )}
              {envRunning && (
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <Loader2 size={12} className="animate-spin" /> 正在检查/修复环境（首次可能需要下载，请稍候）…
                </div>
              )}
              {envOutcome && <OutcomeBanner outcome={envOutcome} successText={`环境就绪${envData?.cliVersion ? `：govio-cli v${envData.cliVersion}` : ""}`} />}
              <button
                type="button"
                onClick={() => void runEnvCheck()}
                disabled={envRunning}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-bg-surface border border-border-default text-text-secondary hover:text-text-primary hover:border-brand/40 transition-colors disabled:opacity-40"
              >
                <RefreshCw size={13} className={envRunning ? "animate-spin" : ""} /> 重新自检
              </button>
            </div>
          )}

          {/* ── Step1 LLM ─────────────────────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-3">
              <div className="text-sm text-text-primary font-medium">LLM 配置</div>
              {status?.modelsConfigured && savedSummary.length > 0 && (
                <div className="text-xs text-text-secondary border border-border-subtle rounded-md px-3 py-2">
                  已配置模型：{savedSummary.join("；")}（重新保存会合并，不破坏其它供应商）
                </div>
              )}
              <div>
                <div className="text-xs text-text-muted mb-1.5">选择供应商（无默认，需主动选择）</div>
                <div className="flex flex-wrap gap-1.5">
                  {PROVIDER_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => choosePreset(p)}
                      className={`px-2.5 py-1 rounded text-xs border transition-colors ${
                        preset?.id === p.id
                          ? "bg-brand/15 border-brand/40 text-brand"
                          : "bg-bg-surface border-border-default text-text-secondary hover:text-text-primary hover:border-brand/40"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {preset && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-text-muted">供应商名称</label>
                      <input value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="openai" className={INPUT_CLASS} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-text-muted">模型 ID</label>
                      <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder={preset.modelHint || "模型 ID"} className={INPUT_CLASS} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-text-muted">Base URL</label>
                      <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" className={INPUT_CLASS} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-text-muted">API 协议</label>
                      <input value={api} onChange={(e) => setApi(e.target.value)} placeholder="openai-completions" className={INPUT_CLASS} />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-text-muted">API Key</label>
                    <div className="relative">
                      <input
                        type={showKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="sk-..."
                        className={`${INPUT_CLASS} pr-9`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
                        title={showKey ? "隐藏" : "显示"}
                      >
                        {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <span className="text-[11px] text-text-dim">保存后加密存于本机 ~/.pi/agent/models.json，不发往大模型</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!providerName.trim() || !baseUrl.trim() || !api.trim() || !apiKey.trim() || !modelId.trim() || llmBusy}
                      onClick={() => void handleSaveAndTest()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {llmBusy && <Loader2 size={13} className="animate-spin" />} 保存并测试
                    </button>
                    <span className="text-[11px] text-text-dim">先保存配置再测试（凭据只走表单 → 后端落盘通道）</span>
                  </div>
                </div>
              )}
              {llmOutcome && (
                <OutcomeBanner
                  outcome={llmOutcome}
                  successText={`模型可用${typeof (llmOutcome.data as { latencyMs?: number } | undefined)?.latencyMs === "number" ? `（${(llmOutcome.data as { latencyMs: number }).latencyMs}ms）` : ""}`}
                />
              )}
            </div>
          )}

          {/* ── Step2 图谱 ────────────────────────────────────────────── */}
          {step === 2 && (
            <div className="space-y-3">
              <div className="text-sm text-text-primary font-medium">图谱初始化</div>
              {status?.graph.initialized ? (
                <div className="text-xs text-text-secondary border border-brand/40 bg-brand/10 rounded-md px-3 py-2">
                  <Check size={12} className="inline text-brand mr-1" />
                  已初始化图后端：{status.graph.backend}
                </div>
              ) : status?.graph.error ? (
                <div className="text-xs text-text-muted">未检测到图后端配置（{status.graph.error}）</div>
              ) : null}
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-sm text-text-primary border border-brand/40 bg-brand/5 rounded-md px-3 py-2 cursor-pointer">
                  <input type="radio" checked={graphBackend === "ladybug"} onChange={() => setGraphBackend("ladybug")} className="mt-0.5 accent-brand" />
                  <span>
                    <span className="font-medium">ladybug（推荐·一键）</span>
                    <span className="block text-[11px] text-text-secondary">本地嵌入式、零外部依赖，落盘 ~/.govio/ontology.lbdb</span>
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => setShowAdvancedGraph((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary"
                >
                  {showAdvancedGraph ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 高级（falkordb / networkx，只收参不建运维）
                </button>
                {showAdvancedGraph && (
                  <div className="space-y-2 border border-border-subtle rounded-md p-3">
                    <label className="flex items-center gap-2 text-xs text-text-secondary">
                      <input type="radio" checked={graphBackend === "falkordb"} onChange={() => setGraphBackend("falkordb")} className="accent-brand" /> falkordb
                    </label>
                    {graphBackend === "falkordb" && (
                      <div className="grid grid-cols-3 gap-2">
                        <input value={falkorHost} onChange={(e) => setFalkorHost(e.target.value)} placeholder="host" className={INPUT_CLASS} />
                        <input value={falkorPort} onChange={(e) => setFalkorPort(e.target.value)} placeholder="port" className={INPUT_CLASS} />
                        <input value={falkorGraph} onChange={(e) => setFalkorGraph(e.target.value)} placeholder="graph" className={INPUT_CLASS} />
                      </div>
                    )}
                    <label className="flex items-center gap-2 text-xs text-text-secondary">
                      <input type="radio" checked={graphBackend === "networkx"} onChange={() => setGraphBackend("networkx")} className="accent-brand" /> networkx（GML 文件）
                    </label>
                    {graphBackend === "networkx" && (
                      <input value={gmlPath} onChange={(e) => setGmlPath(e.target.value)} placeholder="GML 文件路径" className={INPUT_CLASS} />
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={graphBusy || (graphBackend === "networkx" && !gmlPath.trim())}
                onClick={() => void handleInitGraph()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {graphBusy ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />}
                {status?.graph.initialized ? "重新初始化" : "初始化图库"}
              </button>
              {graphOutcome && <OutcomeBanner outcome={graphOutcome} successText={`图库已初始化（${(graphOutcome.data as { backend?: string } | undefined)?.backend ?? graphBackend}）`} />}
            </div>
          )}

          {/* ── Step3 数据源（可跳过） ───────────────────────────────── */}
          {step === 3 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-text-primary font-medium">添加数据源</div>
                <button
                  type="button"
                  onClick={() => {
                    setDsSkipped(true);
                    setStep(4);
                  }}
                  className="text-xs text-text-muted hover:text-text-secondary px-2 py-1 rounded hover:bg-bg-surface"
                >
                  跳过，稍后再加
                </button>
              </div>
              {status && status.datasources.length > 0 && (
                <div className="text-xs text-text-secondary">
                  已配置：{status.datasources.join("、")}
                </div>
              )}
              <DatasourceForm
                submitLabel="保存数据源"
                busy={dsBusy}
                onSubmit={(values, overwrite) => void handleSaveDatasource(values, overwrite)}
                onTest={(values) => void handleTestDatasource(values)}
              />
              {dsTestOutcome && <OutcomeBanner outcome={dsTestOutcome} successText={`连接成功${typeof (dsTestOutcome.data as { latencyMs?: number } | undefined)?.latencyMs === "number" ? `（${(dsTestOutcome.data as { latencyMs: number }).latencyMs}ms）` : ""}`} />}
              {dsSaveOutcome && <OutcomeBanner outcome={dsSaveOutcome} successText="数据源已保存（凭据加密落盘）" />}
            </div>
          )}

          {/* ── 完成态：空状态清单 + next-best-action ───────────────── */}
          {step === 4 && (
            <div className="space-y-3">
              <div className="text-sm text-text-primary font-medium">一切就绪</div>
              <div className="space-y-1.5">
                {[
                  { label: "环境自检", done: isStepDone(0, status, doneFlags) },
                  { label: "LLM 配置", done: isStepDone(1, status, doneFlags) },
                  { label: "图谱初始化", done: isStepDone(2, status, doneFlags) },
                  { label: "数据源（可稍后）", done: isStepDone(3, status, doneFlags) },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-2 text-xs">
                    {item.done ? <Check size={13} className="text-brand" /> : <Circle size={13} className="text-text-dim" />}
                    <span className={item.done ? "text-text-primary" : "text-text-dim"}>{item.label}</span>
                  </div>
                ))}
              </div>
              <div className="border border-border-subtle rounded-md p-3 space-y-2">
                <div className="text-xs text-text-muted">接下来（按顺序体验完整价值）</div>
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  <Database size={13} className="text-brand" /> 1. 在数据源管理器里一键导入元数据（DuckDB 数据源）
                </div>
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  <Rocket size={13} className="text-brand" /> 2. 回到聊天框，问第一个数据问题
                </div>
              </div>
              <div className="text-[11px] text-text-dim">
                信任边界：凭据仅加密存于本机（~/.govio/config.yaml、~/.pi/agent/models.json），不发往大模型；
                agent 在本机有 shell 权限，命令执行前会向你确认。
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent("govio:open-datasources"));
                    onClose();
                  }}
                  className="px-3 py-1.5 rounded text-sm bg-bg-surface border border-border-default text-text-secondary hover:text-text-primary hover:border-brand/40 transition-colors"
                >
                  打开数据源管理器
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 rounded text-sm bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors"
                >
                  开始使用
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 底部导航 */}
        {step < 4 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle flex-shrink-0">
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
              className="px-3 py-1.5 rounded text-sm text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors disabled:opacity-40"
            >
              上一步
            </button>
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(4, s + 1))}
              className="px-3 py-1.5 rounded text-sm bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors"
            >
              {step === 3 ? "完成" : "下一步"}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
