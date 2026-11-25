export interface SlashCommand {
  name: string;
  description: string;
  category: "builtin" | "custom" | "skill";
  /**
   * 参数通道（T3.7）：声明了的命令才能从输入框拿到 `/name <余串>` 里的余串。
   *
   * **缺省 = 不接收参数**，此时行为与 T3.7 之前逐字一致（`/export`、`/clear` 等零变化）：
   * 输入 `/export foo` 仍旧照原样发给 agent，不会被前端截走。
   */
  args?: CommandArgsSpec;
  handler?: (ctx: CommandContext, args: string) => void;
  prompt?: string;
}

/** 命令参数声明（当前只有单参数：一段去掉首尾空白的余串）。 */
export interface CommandArgsSpec {
  /** 用法提示里的占位符，如 `bundle 路径`。 */
  placeholder: string;
  /** 必填时空参数不执行，只给用法提示（避免把空路径发到后端换一句 400）。 */
  required: boolean;
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
  /**
   * `/import <bundle 路径>`：把 T3.6 产出的包导入成一个历史会话（T3.7）。
   * 与 {@link CommandContext.exportSession} 同款约定：实现异步、handler 同步返回，
   * 进度/结果反馈由 ChatInput 展示（成功给会话名 + 节点数，失败给具体原因）。
   *
   * `expectedSha256`（X27，可选）：`<包名>.sha256` 旁文件里的值（或导出方告知的值）。
   * 给了就要求后端强制比对整包校验和；不符则拒绝导入且零写入。
   */
  importSession: (bundlePath: string, expectedSha256?: string) => void;
  addSystemMessage: (content: string) => void;
}
