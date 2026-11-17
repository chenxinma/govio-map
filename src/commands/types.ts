export interface SlashCommand {
  name: string;
  description: string;
  category: "builtin" | "custom" | "skill";
  handler?: (ctx: CommandContext) => void;
  prompt?: string;
}

export interface CommandContext {
  clearMessages: () => void;
  clearCanvas: () => void;
  clearSession: () => void;
  /**
   * `/export`：把当前会话打包成 zip 并下载（T3.6）。
   * 实现是异步的（拉服务端文件集 → 生成交付报告 → 打包），进度/结果反馈由实现方
   * （ChatInput）自己展示；命令 handler 仍然是同步返回。
   */
  exportSession: () => void;
  addSystemMessage: (content: string) => void;
}
