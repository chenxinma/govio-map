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
| `src/commands/export-session.ts` | 会话导出 |
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
  exportSession(): void;
  addSystemMessage(content: string): void;
}
```

## 内置命令

| 命令 | 说明 | handler |
|------|------|---------|
| /clear | 清空聊天消息 | `ctx.clearMessages()` |
| /clear-canvas | 清空画布和消息 | `ctx.clearCanvas()` + `ctx.clearMessages()` |
| /export | 导出会话为 JSON | `ctx.exportSession()` |

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

导出会话为 JSON 文件下载。

输出结构：
```json
{
  "exportedAt": "2026-05-07T...",
  "messages": [
    {"id": "...", "role": "user", "content": "..."},
    {"id": "...", "role": "assistant", "content": "..."}
  ],
  "canvas": {
    "nodes": [{"id": "...", "type": "...", "position": {...}, "data": {...}}],
    "edges": [{"id": "...", "source": "...", "target": "..."}]
  }
}
```

导出时清理：
- 移除 tools 和 isStreaming 字段
- 生成文件名：`govio-session-YYYY-MM-DD.json`
- 通过 Blob + URL.createObjectURL 触发下载

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
