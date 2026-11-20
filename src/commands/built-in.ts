import type { SlashCommand, CommandContext } from "./types";

function handleClear(ctx: CommandContext) {
  ctx.clearSession();
}

function handleClearCanvas(ctx: CommandContext) {
  // 按设计文档只清画布，不动对话（2026-05-07 slash-commands-design 的 Action 定义）。
  ctx.clearCanvas();
  ctx.addSystemMessage("已清理画布并释放所有数据");
}

function handleExport(ctx: CommandContext) {
  // T3.6：/export = 把当前会话打包成 zip（不可变留痕）；异步与进度反馈由 ChatInput 侧承担。
  ctx.exportSession();
}

function handleImport(ctx: CommandContext, args: string) {
  // T3.7：/import <bundle 路径> = 把 T3.6 产出的包导入成一个历史会话。
  // 路径由**服务端**读（浏览器读不到任意本地路径）；空参数的用法提示在 ChatInput 侧拦下，
  // 这里再兜一道，保证 handler 单独被调用时也不会把空串发给后端。
  if (!args.trim()) {
    ctx.addSystemMessage("用法：/import <bundle 路径>（T3.6 /export 产出的 .govio-bundle.zip）");
    return;
  }
  ctx.importSession(args.trim());
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
    {
      name: "import",
      description: "导入会话打包文件为历史会话：/import <bundle 路径>",
      category: "builtin",
      args: { placeholder: "bundle 路径", required: true },
      handler: handleImport,
    },
  ];
}
