import type { SlashCommand, CommandContext } from "./types";

function handleClear(ctx: CommandContext) {
  ctx.clearSession();
}

function handleClearCanvas(ctx: CommandContext) {
  ctx.clearCanvas();
  ctx.clearMessages();
  ctx.addSystemMessage("已清理画布并释放所有数据");
}

function handleExport(ctx: CommandContext) {
  // T3.6：/export = 把当前会话打包成 zip（不可变留痕）；异步与进度反馈由 ChatInput 侧承担。
  ctx.exportSession();
}

export function getBuiltInCommands(): SlashCommand[] {
  return [
    {
      name: "clear",
      description: "清理当前会话上下文",
      category: "builtin",
      handler: handleClear,
    },
    {
      name: "clear-canvas",
      description: "清理画布并释放所有dataframe",
      category: "builtin",
      handler: handleClearCanvas,
    },
    {
      name: "export",
      description: "打包导出当前会话为 zip（画布 + 对话 + 留痕 + 交付报告）",
      category: "builtin",
      handler: handleExport,
    },
  ];
}
