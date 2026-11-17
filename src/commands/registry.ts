import type { SlashCommand } from "./types";
import { getBuiltInCommands } from "./built-in";
import customCommandsData from "../data/commands.json";

interface CustomCommandInput {
  name: string;
  description: string;
  prompt: string;
}

export function loadCommands(): SlashCommand[] {
  const builtIn = getBuiltInCommands();
  const custom: SlashCommand[] = (customCommandsData as CustomCommandInput[]).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    category: "custom" as const,
    prompt: cmd.prompt,
  }));
  return [...builtIn, ...custom];
}

export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase().replace(/^\//, "");
  if (!q) return commands;
  return commands.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(q) ||
      cmd.description.toLowerCase().includes(q)
  );
}

/** `/name <余串>` 的解析结果（仅对声明了 `args` 的命令生效）。 */
export interface ParsedSlashCommand {
  command: SlashCommand;
  /** 命令名之后的余串，已 trim；没给参数时为空串。 */
  args: string;
}

/**
 * 从输入框原文里解析一个**带参数**的内置命令（T3.7）。
 *
 * 为什么只认声明了 `args` 的命令：既有命令（`/export`、`/clear`、自定义 prompt 命令、
 * `/skill:*`）今天的语义是「整行原样发给 agent 或走下拉选中执行」，一旦让本函数去截
 * `/export foo` 这类输入，就等于静默改变了既有行为（T3.7 范围纪律明确要求零变化）。
 *
 * 匹配规则：首个空白前的段与命令名**全等**（大小写不敏感），不做前缀模糊匹配——
 * 模糊匹配会把 `/important-thing` 误判成 `/import`。
 */
export function parseSlashCommand(input: string, commands: SlashCommand[]): ParsedSlashCommand | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const cut = body.search(/\s/);
  const name = (cut === -1 ? body : body.slice(0, cut)).toLowerCase();
  if (name === "") return null;
  const command = commands.find((c) => c.args && c.name.toLowerCase() === name);
  if (!command) return null;
  return { command, args: (cut === -1 ? "" : body.slice(cut + 1)).trim() };
}
