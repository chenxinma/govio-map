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
| `src/commands/CommandSuggestion.tsx` | 命令建议下拉组件 |
| `src/data/commands.json` | 自定义命令配置 |

## 类型定义

```typescript
interface SlashCommand {
  name: string;
  description: string;
  category: "builtin" | "custom";
  handler?: (ctx: CommandContext) => void;
  prompt?: string;
}

interface CommandContext {
  clearMessages(): void;
  clearCanvas(): void;
  clearSession(): void;
  /** 打包导出当前会话为 zip（异步实现，进度/结果反馈由 ChatInput 展示） */
  exportSession(): void;
  addSystemMessage(content: string): void;
}
```

## 内置命令

| 命令 | 说明 | handler |
|------|------|---------|
| /clear | 清空聊天消息 | `ctx.clearMessages()` |
| /clear-canvas | 清空画布和消息 | `ctx.clearCanvas()` + `ctx.clearMessages()` |
| /export | 打包导出当前会话为 zip（画布 + 对话 + 留痕 + 交付报告） | `ctx.exportSession()` |

内置命令有 `handler`，选中时直接执行。

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

## useCommands Hook

```typescript
const { commands, execute } = useCommands(ctx);
```

- `commands`: 合并后的完整命令列表（useMemo 缓存）
- `execute(command)`: 执行命令（仅 builtin 有 handler）

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
