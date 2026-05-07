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
