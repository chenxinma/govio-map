# Slash Commands Design

## Overview

Add a slash command suggestion system to the chat input. Users type `/` to see available commands in a dropdown above the input. Two categories: built-in (local execution) and custom (AI prompts from JSON config).

## Command Types

```typescript
interface SlashCommand {
  name: string;         // "clear", "sql"
  description: string;  // "清理当前会话上下文"
  category: "builtin" | "custom";
  handler?: (ctx: CommandContext) => void;  // built-in only
  prompt?: string;      // custom only
}

interface CommandContext {
  clearMessages: () => void;
  clearCanvas: () => void;
  exportSession: () => void;
}
```

## Built-in Commands

| Command | Description | Action |
|---------|-------------|--------|
| `/clear` | 清理当前会话上下文 | Clear all chat messages from useChat state |
| `/clear-canvas` | 清理画布并释放所有dataframe | Remove all nodes/edges from canvas store |
| `/export` | 导出会话保存成json | Download JSON file with chat messages + canvas nodes/edges |

## Custom Commands

Defined in `src/data/commands.json`:

```json
[
  { "name": "sql", "description": "生成SELECT SQL语句", "prompt": "请生成一个SELECT SQL语句" },
  { "name": "analyze", "description": "分析数据质量", "prompt": "请分析当前数据的质量" }
]
```

Custom commands fill the textarea with the `prompt` text. User can edit before sending.

## Suggestion UI

- Dropdown appears above the textarea when input starts with `/`
- Filters commands as user types (e.g., `/sq` → only `/sql`)
- Keyboard: Arrow Up/Down to navigate, Enter to select, Escape to close
- Click on item to select
- Closes when input no longer starts with `/` or on blur

### Selection Behavior

- **Built-in**: executes handler immediately, clears input, shows system message in chat
- **Custom**: fills textarea with prompt text, user edits and sends manually

## File Structure

```
src/
├── commands/
│   ├── types.ts              # SlashCommand, CommandContext interfaces
│   ├── built-in.ts           # clear, clear-canvas, export handlers
│   ├── registry.ts           # loadCommands(), filterCommands()
│   ├── useCommands.ts        # Hook: command list + execute logic
│   └── CommandSuggestion.tsx # Dropdown UI component
├── data/
│   └── commands.json         # Custom command definitions
├── components/
│   └── Chat/
│       └── ChatInput.tsx     # Modified: integrates useCommands + CommandSuggestion
```

## Integration Points

- `useChat` hook: needs `clearMessages()` method exposed
- `useCanvasStore`: needs `clearCanvas()` method (clears nodes, edges, previewPanels)
- `ChatInput`: add `useCommands` hook, render `CommandSuggestion` dropdown, handle keyboard events
- `ChatPanel`: pass `clearMessages` callback down to ChatInput
