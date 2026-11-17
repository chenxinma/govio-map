# Commands 命令系统

## 概述

聊天输入框支持斜杠命令，分为内置命令和自定义命令两类。

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/commands/types.ts` | 类型定义 |
| `src/commands/built-in.ts` | 内置命令 |
| `src/commands/registry.ts` | 命令注册与过滤 |
| `src/commands/useCommands.ts` | React Hook |
| `src/commands/export-session.ts` | 会话打包导出（zip，T3.6） |
| `src/commands/import-session.ts` | 会话包导入为历史会话（T3.7） |
| `src/commands/CommandSuggestion.tsx` | 命令建议下拉组件 |
| `src/data/commands.json` | 自定义命令配置 |

## 类型定义

```typescript
interface SlashCommand {
  name: string;
  description: string;
  category: "builtin" | "custom";
  /** 参数通道（T3.7）：声明了的命令才能从输入框拿到 `/name <余串>` 里的余串 */
  args?: CommandArgsSpec;
  handler?: (ctx: CommandContext, args: string) => void;
  prompt?: string;
}

interface CommandArgsSpec {
  placeholder: string;   // 用法提示里的占位符，如 "bundle 路径"
  required: boolean;     // 必填时空参数不执行，只给用法提示
}

interface CommandContext {
  clearMessages(): void;
  clearCanvas(): void;
  clearSession(): void;
  /** 打包导出当前会话为 zip（异步实现，进度/结果反馈由 ChatInput 展示） */
  exportSession(): void;
  /** 导入会话包为历史会话（T3.7；同款异步约定） */
  importSession(bundlePath: string): void;
  addSystemMessage(content: string): void;
}
```

### 参数通道（T3.7）

旧命令系统只有 `handler(ctx)`，**拿不到用户在命令名后面输的余串**，所以 `/import <路径>` 无法实现。
T3.7 加了一个**最小**参数通道，关键约束：

- `args` **缺省 = 不接收参数**，此时行为与 T3.7 之前逐字一致：`/export 帮我导出一下` 仍原样发给 agent，
  不会被前端截走（有反向断言）；
- `parseSlashCommand(input, commands)` 只认**声明了 `args`** 的命令，且命令名与首个空白前的段**全等**
  （大小写不敏感）⇒ `/important ...` 不会被误判成 `/import`；
- 余串整体作为**单个参数**（路径可以含空格），首尾空白去掉；
- 下拉里选中带参数的命令是**预填** `/import ` 而不是立即执行（与 skill 命令的 `prompt` 预填同款交互）；
- 必填参数为空时给用法提示 `用法：/import <bundle 路径>` 并预填命令，不打后端。

## 内置命令

| 命令 | 说明 | handler |
|------|------|---------|
| /clear | 清空聊天消息 | `ctx.clearMessages()` |
| /clear-canvas | 清空画布和消息 | `ctx.clearCanvas()` + `ctx.clearMessages()` |
| /export | 打包导出当前会话为 zip（画布 + 对话 + 留痕 + 交付报告） | `ctx.exportSession()` |
| /import `<bundle 路径>` | 导入会话打包文件为历史会话（T3.7，**带参数**） | `ctx.importSession(args)` |

内置命令有 `handler`，选中时直接执行；声明了 `args` 的（当前只有 `/import`）选中时先预填命令等用户补参数。

## 自定义命令

定义在 `src/data/commands.json`：

| 命令 | 说明 | prompt |
|------|------|--------|
| /sql | 生成 SELECT SQL 语句 | "请生成一个SELECT SQL语句" |
| /analyze | 分析数据质量 | "请分析当前数据的质量" |

自定义命令有 `prompt`，选中时填入输入框而非直接执行。

## 命令加载

`loadCommands()` 合并内置命令和自定义命令。自定义命令标记为 `category: "custom"`。

`filterCommands(commands, query)` 按名称或描述过滤，忽略大小写，去除前导 `/`。

`parseSlashCommand(input, commands)`（T3.7）从输入原文解析**带参数**的内置命令，返回
`{ command, args } | null`；只认声明了 `args` 的命令（见上「参数通道」）。

## useCommands Hook

```typescript
const { commands, execute } = useCommands(ctx);
```

- `commands`: 合并后的完整命令列表（useMemo 缓存）
- `execute(command, args?)`: 执行命令（仅 builtin 有 handler）；`args` 缺省空串，所以既有 handler 零改动

## export-session.ts

**T3.6 重做**：`/export` 不再是前端把 `{exportedAt, messages[], canvas{}}` 直接 Blob 下载的简陋 JSON
快照（无 Manifest、无 sidecar、无 token、不经服务端），而是把整个会话打成**自包含 zip**：
同一会话指纹 token 对应同一份可离线归档、可校验、可被导入（T3.7）的产物。

与**只读分享**（T3.5）的分工：分享 = 活视图（内容随源画布实时变化）；导出 = **不可变留痕**。

### 产物

- 文件名：`<token>.govio-bundle.zip`（token = `deriveShareToken(sessionId)`，与分享链接同一个）
- 包内布局（单层、正斜杠，常量在 `src/types/bundle.ts`）：

| 路径 | 内容 |
|------|------|
| `bundle.json` | 包清单：`format`/`version`/`token`/`sessionId`/`exportedAt`/`appVersion` + `files[]`（逐文件 `path`/`bytes`/`sha256`）+ `missing[]` + `excluded.parquet` + `storageProfile?` + `reportOmitted?` |
| `session.jsonl` | 对话 transcript（pi 会话文件原字节） |
| `canvas.json` | 画布 sidecar（节点/边 + 节点内固化的 Analysis Manifest） |
| `manifests.json` | 从画布派生的 Manifest 清单（便利产物） |
| `audit.jsonl` | 权限确认留痕（存在才入包，否则记进 `missing`） |
| `injection.jsonl` | 图谱注入留痕（同上） |
| `report.html` | T1.4 交付报告（可读入口；空画布时不生成，原因写进 `reportOmitted`） |

不入包：`.storage.json`（只留 `storageProfile` 引用名）、`.share.json`（本机分享开关）、`.injection.zip`
（旧格式孤儿）、parquet 等大数据（`excluded.parquet` 记账）、`.env` 与任何凭据。

### 流程

1. `GET /api/session-bundle`（基址由 `apiBaseFrom(window.location.origin) ?? ''` 推导）拿服务端读到的
   会话文件集（含服务端算好的 sha256）；
2. 用**包内 `canvas.json`**（不是画布 store 的实时状态）生成 `report.html`，保证包内自洽；
3. WebCrypto 补算 `report.html` 的 sha256 → 组装 `bundle.json`（它不列自己）；
4. fflate `zipSync`（条目 mtime 固定为 `exportedAt` ⇒ 同内容两次打包字节一致）；
5. Blob + `a[download]` 下载（**仅浏览器下载**，不写工作目录）。

### 反馈

`ChatInput` 在输入框上方展示一句话进度/结果（与 CanvasToolbar 的导出提示同款形态，8s 自动消失）：
打包中 / `已导出 <文件名>（X KB · N 个文件 · 含交付报告 · 未含 M 个 parquet）` / `导出失败：<原因>`。
失败原因都是人话（无活动会话 / 会话已删 / 超限 / 载荷版本不符 / 非安全上下文无法算校验和），不静默失败。
打包进行中重复触发不会并发第二次。

## import-session.ts

**T3.7 新增**：`/import <bundle 路径>` 把 T3.6 产出的 `<token>.govio-bundle.zip` 导入成一个**历史会话**。
浏览器读不到任意本地路径，所以路径交给**服务端**读（`POST /api/session-import`）；校验（格式版本 /
文件清单 / 逐文件 sha256 / 清单外条目）与原子落盘全在服务端（`server/session-import.ts`，
路由与错误码表见 `docs/specs/06-backend.md`）。本模块只做三件事：发请求、把错误码翻成人话
（`IMPORT_ERROR_TEXT`）、把成功结果整理成一句可展示的反馈（`describeImportResult`）。

用户裁决：包可**从任意路径**读（如 `D:/Downloads/xxx.govio-bundle.zip`），但**写入严格限定**
`.govio/sessions/`；校验全绿前零文件写入；id 冲突一律生成新 id（不提供覆盖）。

### 反馈

与 `/export` 共用输入框上方那一行提示（`commandNote`，8s 自动消失）：
`正在校验并导入 <路径> …` / `已导入为历史会话「<名>」（N 节点 · N 边 · N 条对话 · N 份分析留痕 · 数据文件未随包…）`
/ `导入失败：<人话原因>`。成功后调 `onSessionsChanged()`（= `useChat().fetchSessions`）走**既有** WS
`session_list` 重拉会话列表 ⇒ 不新增 WS 消息类型，`PROTOCOL_VERSION` 仍为 1。
失败原因全部是人话（找不到包 / 校验和不符 / 清单外夹带 / 版本不支持 / 超限 / 目标已存在…），不静默失败；
导入进行中重复触发不会并发第二次。

### 导入会话的降级语义

包里**不含 parquet**（T3.6 裁决 ③），所以导入会话的 DataFrame 预览/复跑大概率不可用：

- **预览**：`openPreviewPanel` 取数失败不再只 `console.error`（以前会静默渲染成「0 rows」空表），
  而是把原因挂到 `PreviewPanel.previewError` 并在面板里渲染告警块（隐藏空表与分页页脚）；
  404 给「数据不在本机 + 需重新加载该 DataFrame」的专用文案；
- **复跑**：沿用 T1.2 已有链路——失败会把原因记进 `rerunHistory`（`outcome:'error'`）并由 `RerunStatus` 展示；
- **存储绑定**：`bundle.json.storageProfile` 有值时只在导入结果里告知「源实例曾绑定 profile X，本机未绑定」，
  **不自动建绑定**（decisions ③）。

## CommandSuggestion 组件

命令建议下拉列表，定位在输入框上方 (`absolute bottom-full`)。

### Props

| 属性 | 类型 | 说明 |
|------|------|------|
| commands | SlashCommand[] | 过滤后的命令列表 |
| selectedIndex | number | 当前选中索引 |
| onSelect | (cmd) => void | 选择回调 |
| onHover | (index) => void | 悬停回调 |

### 视觉

- 内置命令：Terminal 图标（品牌绿）
- 自定义命令：Sparkles 图标（琥珀色）
- 选中项自动滚动到可视区域
