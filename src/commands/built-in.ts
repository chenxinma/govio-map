import type { SlashCommand, CommandContext } from "./types";

function handleClear(ctx: CommandContext) {
  ctx.clearMessages();
  ctx.addSystemMessage("已清理会话上下文");
}

function handleClearCanvas(ctx: CommandContext) {
  ctx.clearCanvas();
  ctx.clearMessages();
  ctx.addSystemMessage("已清理画布并释放所有数据");
}

function handleExport(ctx: CommandContext) {
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
      description: "导出会话保存成json",
      category: "builtin",
      handler: handleExport,
    },
  ];
}
