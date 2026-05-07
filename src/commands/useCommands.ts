import { useMemo, useCallback } from "react";
import { loadCommands } from "./registry";
import type { SlashCommand, CommandContext } from "./types";

export function useCommands(ctx: CommandContext) {
  const commands = useMemo(() => loadCommands(), []);

  const execute = useCallback(
    (command: SlashCommand) => {
      if (command.category === "builtin" && command.handler) {
        command.handler(ctx);
      }
    },
    [ctx]
  );

  return { commands, execute };
}
