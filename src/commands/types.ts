export interface SlashCommand {
  name: string;
  description: string;
  category: "builtin" | "custom";
  handler?: (ctx: CommandContext) => void;
  prompt?: string;
}

export interface CommandContext {
  clearMessages: () => void;
  clearCanvas: () => void;
  exportSession: () => void;
  addSystemMessage: (content: string) => void;
}
