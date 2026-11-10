/**
 * X11 BUGFIX 回归测试：LLM 设置对话框 provider 编辑态（utils/provider-drafts）。
 *
 * 回归来源：用户报告 2026-11-10「provider name 输入框每输入一个字符光标就跳开，无法连续输入」。
 * 根因是 SettingsModal 用 provider **名称**当 React `key`（`key={name}`），而名称又是该 input
 * 的受控值 → 每键改键名 → key 变化 → 整卡片重挂载 → 焦点/光标丢失。
 *
 * 驱动方式：纯逻辑直测（toDrafts / toConfig / validateDrafts / canSaveDrafts），node 环境无 DOM，
 * 故对「key 必须是稳定 uid」这条 DOM 行为加一条源码契约断言兜底（见最后一个 describe）。
 *
 * 覆盖：
 *  - uid 与名称解耦：同名两条草稿 uid 不同；改名不改 uid、不改顺序
 *  - toDrafts：顺序保留、深拷贝（改草稿不污染入参）、空配置回落默认 deepseek
 *  - toConfig：trim 名称、丢空名、过滤空模型 id、全空回填占位、保留模型显示名（与修复前语义一致）
 *  - 往返：toConfig(toDrafts(cfg)) 幂等
 *  - validateDrafts / canSaveDrafts：空名、重名（修复前重名会静默覆盖丢 provider）、缺 baseUrl/api/模型
 *  - suggestProviderName：跳过已占用名
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelsConfig, ProviderConfig } from "../../src/types/models-config.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_PROVIDER_NAME,
  canSaveDrafts,
  emptyProviderDraft,
  suggestProviderName,
  toConfig,
  toDrafts,
  validateDrafts,
  type ProviderDraft,
} from "../../src/utils/provider-drafts.js";

function cfg(baseUrl = "https://api.a.com", api = "openai-completions", models = [{ id: "m1" }]): ProviderConfig {
  return { baseUrl, api, apiKey: "sk-x", models };
}

function sample(): ModelsConfig {
  return {
    providers: {
      deepseek: { ...cfg("https://api.deepseek.com"), models: [{ id: "deepseek-chat", name: "DeepSeek V3" }] },
      openai: cfg("https://api.openai.com", "openai-responses", [{ id: "gpt-4o" }, { id: "" }]),
    },
  };
}

describe("provider-drafts：uid 与名称解耦（X11 主因回归）", () => {
  it("两条同名草稿 uid 不同（修复前重名会静默覆盖丢一个 provider）", () => {
    const a = emptyProviderDraft("openai");
    const b = emptyProviderDraft("openai");
    expect(a.uid).not.toBe(b.uid);
    expect(a.uid).toBeTruthy();
  });

  it("改名不改 uid、不改顺序：模拟逐字符连续输入 'openai'", () => {
    const drafts = toDrafts(sample());
    const uidsBefore = drafts.map((d) => d.uid);
    // 逐字符输入：每一步只改 name 字段，uid 必须始终稳定（否则 React key 变化 → 重挂载失焦）
    let cur = drafts;
    for (const partial of ["o", "op", "ope", "open", "opena", "openai"]) {
      cur = cur.map((d, i) => (i === 0 ? { ...d, name: partial } : d));
      expect(cur.map((d) => d.uid)).toEqual(uidsBefore);
    }
    expect(cur[0].name).toBe("openai");
    expect(cur[1].name).toBe("openai"); // 重名在编辑期允许存在，由校验拦截
    expect(validateDrafts(cur).map((i) => i.kind)).toEqual(["duplicate-name", "duplicate-name"]);
  });

  it("uid 不含名称内容，改名后仍唯一", () => {
    const drafts = toDrafts(sample()).map((d) => ({ ...d, name: "同名" }));
    expect(new Set(drafts.map((d) => d.uid)).size).toBe(drafts.length);
  });
});

describe("provider-drafts：toDrafts", () => {
  it("保留原有键顺序并深拷贝（改草稿不污染入参）", () => {
    const src = sample();
    const drafts = toDrafts(src);
    expect(drafts.map((d) => d.name)).toEqual(["deepseek", "openai"]);
    drafts[0].name = "changed";
    drafts[0].cfg.models[0].id = "mutated";
    drafts[0].cfg.baseUrl = "http://evil";
    expect(Object.keys(src.providers)).toEqual(["deepseek", "openai"]);
    expect(src.providers.deepseek.models[0].id).toBe("deepseek-chat");
    expect(src.providers.deepseek.baseUrl).toBe("https://api.deepseek.com");
  });

  it("无配置 / 空 providers 回落默认 deepseek 草稿", () => {
    for (const input of [null, undefined, { providers: {} } as ModelsConfig]) {
      const drafts = toDrafts(input);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].name).toBe(DEFAULT_PROVIDER_NAME);
      expect(drafts[0].cfg.baseUrl).toBe(DEFAULT_BASE_URL);
      expect(drafts[0].cfg.models).toEqual([{ id: "" }]);
    }
  });

  it("新建草稿的 models 数组不共享引用（修复前 EMPTY_PROVIDER.models 被多处复用）", () => {
    const a = emptyProviderDraft("provider1");
    const b = emptyProviderDraft("provider2");
    expect(a.cfg.models).not.toBe(b.cfg.models);
    a.cfg.models.push({ id: "x" });
    expect(b.cfg.models).toEqual([{ id: "" }]);
  });
});

describe("provider-drafts：toConfig 落盘语义（与修复前 handleSave 一致）", () => {
  it("trim 名称、过滤空模型 id、保留模型显示名", () => {
    const drafts: ProviderDraft[] = [
      { uid: "u1", name: "  openai  ", cfg: cfg("https://a", "openai-responses", [{ id: " gpt-4o ", name: "GPT-4o" }, { id: "  " }]) },
    ];
    expect(toConfig(drafts)).toEqual({
      providers: {
        openai: { baseUrl: "https://a", api: "openai-responses", apiKey: "sk-x", models: [{ id: "gpt-4o", name: "GPT-4o" }] },
      },
    });
  });

  it("丢弃空名草稿；模型全空时回填一个空 id 占位", () => {
    const drafts: ProviderDraft[] = [
      { uid: "u1", name: "   ", cfg: cfg() },
      { uid: "u2", name: "kept", cfg: cfg("https://k", "openai-completions", [{ id: "" }]) },
    ];
    const out = toConfig(drafts);
    expect(Object.keys(out.providers)).toEqual(["kept"]);
    expect(out.providers.kept.models).toEqual([{ id: "" }]);
  });

  it("往返幂等：toConfig(toDrafts(cfg)) 等价于规范化后的 cfg", () => {
    const src = sample();
    const once = toConfig(toDrafts(src));
    expect(once.providers.deepseek).toEqual({
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      apiKey: "sk-x",
      models: [{ id: "deepseek-chat", name: "DeepSeek V3" }],
    });
    expect(once.providers.openai.models).toEqual([{ id: "gpt-4o" }]);
    expect(toConfig(toDrafts(once))).toEqual(once);
  });

  it("重名草稿不会静默丢条目——保存被 canSave 拦下", () => {
    const drafts: ProviderDraft[] = [
      { uid: "u1", name: "dup", cfg: cfg() },
      { uid: "u2", name: "dup", cfg: cfg("https://b") },
    ];
    expect(canSaveDrafts(drafts)).toBe(false);
    expect(Object.keys(toConfig(drafts).providers)).toHaveLength(1); // 若无校验就会丢一条
  });
});

describe("provider-drafts：校验与保存可用性", () => {
  it("空名 → empty-name；重名 → 两条 duplicate-name；干净配置 → 无 issue", () => {
    expect(validateDrafts([{ uid: "u1", name: " ", cfg: cfg() }])).toEqual([
      { uid: "u1", kind: "empty-name", message: "Provider 名称不能为空" },
    ]);
    const dup = validateDrafts([
      { uid: "u1", name: "a", cfg: cfg() },
      { uid: "u2", name: " a ", cfg: cfg() },
    ]);
    expect(dup).toHaveLength(2);
    expect(dup.every((i) => i.kind === "duplicate-name")).toBe(true);
    expect(dup.map((i) => i.uid)).toEqual(["u1", "u2"]);
    expect(validateDrafts(toDrafts(sample()))).toEqual([]);
  });

  it("canSaveDrafts：缺 baseUrl / api / 模型 id 或无草稿均不可保存", () => {
    expect(canSaveDrafts([])).toBe(false);
    expect(canSaveDrafts([{ uid: "u1", name: "", cfg: cfg() }])).toBe(false);
    expect(canSaveDrafts([{ uid: "u1", name: "a", cfg: cfg("  ") }])).toBe(false);
    expect(canSaveDrafts([{ uid: "u1", name: "a", cfg: cfg("https://a", " ") }])).toBe(false);
    expect(canSaveDrafts([{ uid: "u1", name: "a", cfg: cfg("https://a", "openai-completions", [{ id: " " }]) }])).toBe(false);
    expect(canSaveDrafts([{ uid: "u1", name: "a", cfg: cfg() }])).toBe(true);
    expect(canSaveDrafts(toDrafts(sample()))).toBe(true);
  });

  it("suggestProviderName 跳过已占用名", () => {
    expect(suggestProviderName([])).toBe("provider1");
    expect(suggestProviderName([{ uid: "u1", name: "provider1", cfg: cfg() }])).toBe("provider2");
    expect(
      suggestProviderName([
        { uid: "u1", name: "provider1", cfg: cfg() },
        { uid: "u2", name: " provider3 ", cfg: cfg() },
      ])
    ).toBe("provider2");
  });
});

describe("SettingsModal 源码契约（DOM 行为无法在 node 环境直测，故加静态兜底）", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../src/components/SettingsModal.tsx", import.meta.url)),
    "utf8"
  );

  it("provider 卡片 key 用稳定 uid，绝不用名称", () => {
    expect(src).toContain("key={draft.uid}");
    expect(src).not.toContain("key={name}");
    expect(src).not.toContain("key={draft.name}");
    expect(src).not.toContain("key={provider");
  });

  it("名称输入框受控于草稿字段，onChange 只更新 name（不改 React key）", () => {
    expect(src).toMatch(/value=\{draft\.name\}/);
    expect(src).toMatch(/onChange=\{\(e\) => updateName\(draft\.uid, e\.target\.value\)\}/);
  });
});
