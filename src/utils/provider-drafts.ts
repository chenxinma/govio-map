/**
 * LLM 设置对话框的 provider 编辑态（X11 BUGFIX）：Record ↔ 有序草稿数组 互转 + 校验。
 *
 * 起因：SettingsModal 曾以 provider **名称本身**当 React `key`（`key={name}`），而名称又是
 * input 的受控值 → 每敲一个字符 key 变化 → React 卸载旧子树、挂载全新 DOM input → 焦点与
 * 光标位置每键丢失，无法连续输入。修复方式是引入与内容无关的稳定 `uid` 作 key，名称降级为
 * 草稿上的普通可编辑字段（允许编辑期为空/重名，保存前统一校验）。
 *
 * 本模块只含纯逻辑（无 React/DOM 依赖），可在 node 环境直接单测：
 * `tests/integration/settings-provider-drafts.test.ts`。
 */
import type { ModelsConfig, ProviderConfig } from '../types/models-config';

/** 单个 provider 的编辑态：uid 一经生成不再变化，name 可自由编辑 */
export interface ProviderDraft {
  /** 稳定标识，仅用于 React key 与错误定位，不落盘 */
  uid: string;
  /** provider 名称（落盘时作为 Record 的键，保存前 trim） */
  name: string;
  cfg: ProviderConfig;
}

export type DraftIssueKind = 'empty-name' | 'duplicate-name';

/** 保存前校验问题（用于禁用保存按钮 + 就地提示） */
export interface DraftIssue {
  uid: string;
  kind: DraftIssueKind;
  message: string;
}

/** 无既有配置时的默认 provider（保持修复前 SettingsModal 的默认值不变） */
export const DEFAULT_PROVIDER_NAME = 'deepseek';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_API = 'openai-completions';

let uidSeq = 0;

/** 生成进程内单调递增的草稿 uid（与用户输入无关，故可安全用作 React key） */
export function nextProviderUid(): string {
  uidSeq += 1;
  return `pvd-${uidSeq}`;
}

function cloneConfig(cfg: Partial<ProviderConfig> | undefined): ProviderConfig {
  const models = Array.isArray(cfg?.models) ? cfg!.models : [];
  return {
    baseUrl: cfg?.baseUrl ?? '',
    api: cfg?.api ?? DEFAULT_API,
    apiKey: cfg?.apiKey ?? '',
    // 深拷贝：修复前多个新增 provider 共享 EMPTY_PROVIDER.models 同一数组引用
    models: models.length > 0 ? models.map((m) => ({ ...m })) : [{ id: '' }],
  };
}

/** 新建一条草稿（name 缺省时由调用方决定占位名） */
export function emptyProviderDraft(name = ''): ProviderDraft {
  return { uid: nextProviderUid(), name, cfg: cloneConfig(undefined) };
}

/**
 * 落盘配置 → 编辑态数组：保留原有键顺序，深拷贝避免污染入参。
 * 配置缺失或无任何 provider 时返回默认 deepseek 草稿（与修复前的初始态一致）。
 */
export function toDrafts(config: ModelsConfig | null | undefined): ProviderDraft[] {
  const providers = config?.providers;
  if (!providers || Object.keys(providers).length === 0) {
    return [{ uid: nextProviderUid(), name: DEFAULT_PROVIDER_NAME, cfg: cloneConfig({ baseUrl: DEFAULT_BASE_URL }) }];
  }
  return Object.entries(providers).map(([name, cfg]) => ({
    uid: nextProviderUid(),
    name,
    cfg: cloneConfig(cfg),
  }));
}

/** 新增草稿的占位名：provider1 / provider2 …（跳过已占用的名字，与修复前一致） */
export function suggestProviderName(drafts: ProviderDraft[]): string {
  const taken = new Set(drafts.map((d) => d.name.trim()));
  let idx = 1;
  while (taken.has(`provider${idx}`)) idx += 1;
  return `provider${idx}`;
}

/**
 * 编辑态 → 落盘配置：trim 名称、丢弃空名条目、过滤空模型 id（全空时回填一个空 id 占位）。
 * 语义与修复前的 handleSave 完全一致，仅遍历对象从 Record 换成有序草稿数组。
 */
export function toConfig(drafts: ProviderDraft[]): ModelsConfig {
  const providers: Record<string, ProviderConfig> = {};
  for (const draft of drafts) {
    const name = (draft.name ?? '').trim();
    if (!name) continue;
    const models = (draft.cfg.models ?? [])
      .map((m) => ({ ...m, id: (m.id ?? '').trim() }))
      .filter((m) => m.id);
    providers[name] = { ...draft.cfg, models: models.length > 0 ? models : [{ id: '' }] };
  }
  return { providers };
}

/**
 * 校验：名称为空 / trim 后重名。
 * 修复前重名不可能出现（重命名成已有键会静默覆盖并丢掉一个 provider），改为草稿字段后
 * 重名成为可达状态，必须在保存前拦下，否则 toConfig 会静默丢条目。
 */
export function validateDrafts(drafts: ProviderDraft[]): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const byName = new Map<string, string[]>();

  for (const draft of drafts) {
    const name = (draft.name ?? '').trim();
    if (!name) {
      issues.push({ uid: draft.uid, kind: 'empty-name', message: 'Provider 名称不能为空' });
      continue;
    }
    const seen = byName.get(name);
    if (seen) seen.push(draft.uid);
    else byName.set(name, [draft.uid]);
  }

  for (const [name, uids] of byName) {
    if (uids.length < 2) continue;
    for (const uid of uids) {
      issues.push({ uid, kind: 'duplicate-name', message: `Provider 名称重复："${name}"` });
    }
  }
  return issues;
}

/** 保存可用性：至少一条草稿、无名称问题、每条 baseUrl/api 非空且至少一个模型 id 非空 */
export function canSaveDrafts(drafts: ProviderDraft[]): boolean {
  if (drafts.length === 0) return false;
  if (validateDrafts(drafts).length > 0) return false;
  return drafts.every((d) => {
    const cfg = d.cfg;
    return Boolean(
      (cfg.baseUrl ?? '').trim() &&
        (cfg.api ?? '').trim() &&
        (cfg.models ?? []).some((m) => (m.id ?? '').trim())
    );
  });
}
