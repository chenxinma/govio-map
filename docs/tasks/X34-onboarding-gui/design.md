# X34 design.md：降低初始配置门槛（onboarding GUI）

> 任务：govio-map `docs/task-plan.json` → crossCutting X34。
> 前置：X33（govio-cli onboard 非交互图后端，见 `docs/tasks/X33-onboard-noninteractive/FRD.md`）。
> 本文是需求重构与方案设计，落地实现见 CHANGES.md、验证见 verification.md。

---

## 1. 问题重构：不是「补表单」，而是「TTFV 漏斗 + 信任边界」

用户目标字面上是「给初始配置做一组 GUI」。顶尖 UX 专家会先问 **Job-to-be-Done**：

> *「在一个全新环境，用最短时间、零泄密、有信心的前提下，从 `npx govio-map` 走到第一次数据问题被回答。」*

把这个 Job 拆成一条 **TTFV 漏斗**（time-to-first-value），每段都是可测的流失点：

```
npx 启动 → 依赖就绪 → LLM 可用 → 图谱就绪 → 数据源连上 → 元数据可见 → 第一个问题被回答
```

设计对象不是「LLM 表单 / 图谱表单 / 数据源表单」三个孤立组件，而是**这条漏斗上每步的状态 + 下一步最该做什么（next-best-action）**，落成一个**有状态、可跳过、可续做、每步可验证**的渐进式向导。

**「更深」与「更大」的分界线**：加表单是「更大」；把 onboarding 变成可恢复的旅程、并把秘密边界变成结构性约束是「更深」。

## 2. 现状盘点（决定哪些是「真缺口」）

| 现状 | 结论 |
|---|---|
| `SettingsModal` 已能完整编辑 `models.json`（脱敏回显 `maskApiKey`、`unmaskFromDisk` 防覆盖）+ `ModelSelect` | **复用** |
| 首启 `ConfigModal` 硬编码 DeepSeek（`models-config.ts` `createDefaultConfig` 写死 `api.deepseek.com`） | **删除硬编码**，改多供应商预置模板 |
| `DataSourcesModal` 只读列表 + 「导入元数据」往聊天框预填 `/导入元数据 数据源:xxx` | **升级为管理器**（增删改+测试+导元数据），**删除预填回灌路径** |
| 图库初始化（`govio-cli onboard`）无 GUI，前端拿不到「是否已 onboard / 后端类型」状态 | **新增 onboard 状态与驱动**（依赖 X33） |
| `govio-cli onboard`：数据源非交互 ✓，图后端仅交互式 | 由 **X33** 补齐图后端非交互 |
| 配置落点 `~/.govio/config.yaml`（图+数据源）、`~/.pi/agent/models.json`（LLM）；后端 loopback | 作为信任信号展示 |

## 3. 从 outcome 出发的需求（北极星 + R0–R7）

- **R0 北极星**：全新环境 npx → 首次问数 ≤ 5 分钟（本地示例）/ ≤ 10 分钟（真实库）；全程 **0 次**聊天框粘贴凭据。
- **R1 首次成功路径**：单一 3–4 步向导（LLM → 图谱 → 数据源），每步可跳过/延后，图谱默认本地嵌入式（ladybug）。
- **R2 秘密安全**：凭据只走表单 → 后端 → govio-cli，加密落盘；GUI 明示存储位置与加密状态；日志/prompt 零泄露。
- **R3 即时可验证**：测试模型 / 测试连接，失败给可读原因与修复。
- **R4 可恢复/幂等**：向导反映当前真实状态；重复进入不覆盖；部分完成可续做。
- **R5 可观测进度**：长耗时步骤（uv install / skills 下载 / graph init）有进度。
- **R6 信任信号**：明确「凭据不发往大模型」+「agent 有本机 shell 权限」边界。
- **R7 无默认供应商锁定**：预置 OpenAI/Anthropic/DeepSeek/Gemini + 自定义。

## 4. 用户未要求、但必须纳入的 gap（G1–G10）

| # | gap | 落点 |
|---|---|---|
| G1 | 分阶段、可跳过的向导（图库默认本地、数据源可延后） | Step 2/3 可跳过 |
| G2 | 环境自检 pre-flight（uv / govio-cli 版本 / skills），缺则带进度自动修复 | Step 0 |
| G3 | 每步即时验证（测试模型 / 测试连接） | Step 1/3 |
| G4 | 秘密心智模型与信任信号 | 数据源表单 + 全局 |
| G5 | 空状态 + 下一步引导 | 完成态清单 |
| G6 | 幂等 / 可续做 | 向导状态感知 |
| G7 | 长耗时进度与耗时预期 | Step 0/2 |
| G8 | 纯文本错误 → 可行动修复指引 | 全部步骤 |
| G9 | 去供应商锁定 | Step 1 |
| G10 | 数据源全生命周期（增删改+测试+导元数据） | 数据源管理器 |

**核心（G10 之外的「更深」）——秘密的结构性路由**：把「凭据只走表单、永不进聊天上下文」固化为产品规则。当 agent 或 prompt 出现 `scheme://user:pass@host` 连接串/明文密码时，**系统拦截并 redirect 到 GUI 表单**，而非执行。即：表单成为唯一合法凭据路径 + agent/系统层「拒绝并重定向」守卫 + 可断言的「秘密零进入 prompt」验证。这是从根上消除泄密，而非在泄密通道旁再开门。

## 5. 设计方法与工具（本任务采用）

- **Jobs-to-be-Done**：从「要完成的事」而非功能清单出发（§1/§3）。
- **认知走查 + Nielsen 10 启发式**：对 `ConfigModal/SettingsModal/DataSourcesModal` 逐条过，输出违规清单（无状态反馈、硬编码供应商、无可恢复出口）。
- **TTFV 漏斗 + 可遥测**：把 G1–G10 映射成每步完成率/耗时/错误率/放弃点，匿名埋点（可关闭）找最大流失步。
- **5 人可用性测试**（Nielsen 经典样本量）：无主持 think-aloud + 录屏，度量任务成功率/时间/错误/求助。
- **标准化量表**：SUS（≥68 为良好）+ 单任务 SEQ。
- **原型先行**：Figma 线框 → 可点击原型 → 绑定真实 CLI 前 lo-fi 测试。
- **Microcopy 作为一等对象**：错误/空状态/安全声明/进度文案逐条评审。
- **安全 UX 模式**：掩码显隐、测试连接不落盘、信任声明、密钥轮换/删除入口。
- **UX 需求转可验收断言**：复用本仓库 `verify:*` 断言文化，新增 `verify:onboarding` + `verify:secrets-isolation`。

## 6. 证据体系（除「你我」之外如何证明有效）

| 证据层 | 方法 | 目标口径 |
|---|---|---|
| 冷启动可用性 | 招募 5 名从未见过的目标用户（数据分析师/数据治理者，非作者），think-aloud 三任务 | 完成率 100%（5/5）；TTFV ≤5（本地）/≤10（真实库）分钟；**聊天框粘贴密码 = 0** |
| 前后对照 | 同批用户先测当前 CLI 流程作 baseline，再测新流程 | TTFV 有数量级下降（非主观） |
| 漏斗遥测 | 埋点每步完成率/放弃率/耗时/错误 | 找到并消除最大流失步 |
| 标准化量表 | SUS + SEQ | SUS ≥ 68 附行业对比 |
| 安全证明 | `verify:secrets-isolation` CI 断言：凭据零进入 prompt/日志/进程参数/环境导出；连接串被拦截 redirect | 机器保证，非口头 |
| 长期信号 | GitHub issues / 社区「卡在安装/配置」占比趋势 | 持续北极星 |

**第 5 层（安全证明）** 是把「对话粘贴密码会泄露」从「我保证」变成「机器保证」，复用 `permission-audit` / `prompt-injection` 既有基建。

## 7. 修订后需求（完整、可验收）

- **R0 北极星**：见 §3。
- **R1 单一首启向导**：Step0 环境自检（带进度自动修复，复用 `ensureGovioCli` + `downloadGovioSkills`）→ Step1 LLM（预置模板 + 测试模型，去 DeepSeek 硬编码）→ Step2 图谱（默认 ladybug 一键，高级 falkordb/networkx 只收参）→ Step3 数据源（表单 + 测试连接，可跳过）→ 完成态空状态清单。每步幂等可续做、即时验证。
- **R2 秘密结构性路由**：GUI 表单为唯一凭据入口；凭据经后端 → 子进程 `govio-cli onboard --backend ladybug [--add-datasource ...]` 加密落盘；agent/prompt 出现连接串时拦截 redirect；新增 `verify:secrets-isolation`。
- **R3 数据源管理器**：增删改 + 测试连接 + 一键导元数据 + 查看落盘位置；删除预填 `/导入元数据` 回灌路径。
- **R4 完成态空状态 + 下一步引导**：对齐漏斗 G1–G5。
- **R5 验证体系**：`verify:onboarding`（幂等/可恢复）+ `verify:secrets-isolation` + 5 人冷启动报告（TTFV baseline + SUS），三者为交付门槛。

### 明确不做（范围纪律）

多租户、云同步、SSO/RBAC、管理员控制台、配置迁移工具、agent 凭据托管；图库高级后端（falkordb/networkx）只收参、不建运维能力。

## 8. 架构裁决

1. **默认图库 = ladybug**（用户 2026-11-26 裁决）：`~/.govio/ontology.lbdb`，零外部依赖，一键初始化。
2. **非交互 onboard 缺口**：图后端配置需 X33 补齐 `--backend` 旗标；数据源非交互已具备。GUI 全部经 govio-cli 子进程驱动，**Node 不直写 config.yaml**（遵守「一切经 govio-cli」纪律，避免绕过 `ConfigManager` 备份与密码加密）。
3. **秘密路由边界**：凭据生命周期只在「前端表单 ↔ 后端子进程 ↔ 磁盘」；永不进 LLM 上下文、日志、进程参数、环境导出。守卫在**后端**（拦截 prompt 中的连接串），系统提示补「凭据只走表单」规则。
4. **复用而非重写**：`SettingsModal`（脱敏/草稿机制）、`ensureGovioCli`/`downloadGovioSkills`、`observe_info` 通道均复用；`ConfigModal` 退化为向导入口，`DataSourcesModal` 升级为管理器。

## 9. 方案与取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| 首启入口 | 单一 stepper 向导（取代三散弹窗） | TTFV 漏斗一致、可续做；散弹窗无法表达「步骤间依赖与跳过」 |
| LLM 默认 | 无默认供应商（必须选一个 + 预置模板） | 去掉 DeepSeek 硬编码（R7），默认中立是信任的一部分 |
| 图谱默认 | ladybug 本地嵌入式 | 零外部服务，最低门槛（用户裁决） |
| 数据源凭据 | 只走表单 → 后端子进程 → govio-cli | 结构性防泄密；不直写 config.yaml |
| 秘密守卫 | 后端拦截 + redirect（非仅靠系统提示自觉） | 提示是软约束，拦截是硬约束 |
| 拦截审计留痕落点（P1a 裁决） | 新建 `<session>.secret-guard.jsonl` 轻量 sidecar（permission-audit 同款 append-only，随 deleteSession 清理；暂不入 session-bundle 导出） | 不扩展 `.injection.jsonl`：注入留痕语义是「prompt 里进了什么」，拦截事件是「拒绝了什么」，混写会逼 trace 换版本且语义混淆；独立 sidecar 只记 sessionId/时间/类别/内容 SHA-256（零明文），可被 verify:secrets-isolation 单独断言 |
| 验证 | 新增两项 verify 脚本进 CI | 把「不泄露」「可续做」变成可断言，而非人工目测 |

## 10. 遗留问题

1. **测试连接的后端探测手段**：govio-cli 是否有轻量「连通性探测」子命令，还是需复用 `observe info`（较重）或新增 `observe` 侧探测——需在实现时确认；若无，评估在 govio 侧补一个轻量探测（归口 X33 或新增小任务）。
2. **秘密守卫的覆盖边界**：仅拦截 `scheme://user:pass@host` 与明文密码，还是连「用户口头说『密码是 xxx』」也拦——拦截规则与误伤率需实测定阈值。→ **P1a 裁决（任务书）**：宁可误拦不可漏拦；拦截语义=「拒绝执行 + 可读引导」（`secret_redirect`）而非静默丢弃。覆盖形态收敛为「连接串 `scheme://user:pass@host`（密码段含 URL-encoded，中文「密码是/密码：/密码=」与 `password/passwd/pwd` 的 =/：/--password 赋值形态）；误伤/漏拦阈值待 `verify:secrets-isolation` 实测后调。
3. **遥测埋点**：是否本轮就做匿名漏斗埋点（可关闭），还是先做可用性测试、埋点延后——待用户裁决。
4. **`--backend` + `--remove-datasource` 组合**：X33 FRD §5 标注「由实现方裁决」，需在 X33 完成时回填结论。
5. **MIN_GOVIO_CLI_VERSION**：X33 发布新 govio 版本后，本任务同步提升该常量（`server/govio-installer.ts`）。
6. **可用性测试的执行人/渠道**：5 人招募由谁发起、录屏工具与报告模板，需在验证阶段确定（主会话牵头）。
7. **followUp 分支未纳入 P1a 守卫**：任务书只覆盖 prompt/steer，但 followUp 同样进 LLM 上下文，留有绕行口；补齐即同一守卫三行（secret_redirect 回执）——需裁决 P1b/P3 是否一并覆盖（verify:secrets-isolation 断言口径也取决于此）。
8. **secret_redirect 的前端收尾（P2）**：被拦 steer 的气泡投递态（消息不带 clientMsgId）、被拦文本在前端聊天态/localStorage 的残留是否脱敏——由 P2 聊天 UI 一并裁决。
