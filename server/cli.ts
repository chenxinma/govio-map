import { getOrCreateSession, agentSetup } from "./agent.js";
import { parseArgs } from "node:util";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

type MessageEvent = Extract<AgentEvent, { type: "message_start" | "message_end" }>;

const { values } = parseArgs({
  options: {
    message: { type: "string", short: "m" },
    raw: { type: "boolean", short: "r" },
  },
  strict: true,
});

const message = values.message;
if (!message) {
  console.error('Usage: tsx server/cli.ts -m "your question"');
  process.exit(1);
}

function writeLine(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  await agentSetup();
  const session = await getOrCreateSession();

  const unsubscribe = session.subscribe((event) => {
    if (values.raw) {
      writeLine(event);
    } else {
      switch (event.type) {
      case "message_start":
        if ((event as MessageEvent).message.role === "assistant") {
          writeLine({ type: "message_start" });
        }
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          writeLine({ type: "text_delta", content: event.assistantMessageEvent.delta });
        } else if (event.assistantMessageEvent.type === "thinking_delta") {
          writeLine({ type: "thinking_delta", content: event.assistantMessageEvent.delta });
        }
        break;
      case "tool_execution_start":
        writeLine({ type: "tool_start", toolName: event.toolName, args: event.args });
        break;
      case "tool_execution_end":
        writeLine({ type: "tool_end", toolName: event.toolName, result: event.result, success: !event.isError });
        break;
      case "message_end":
        if ((event as MessageEvent).message.role === "assistant") {
          writeLine({ type: "message_end" });
        }
        break;
      case "agent_end":
        unsubscribe();
        process.exit(0);
      }
    }
  });

  await session.prompt(message);
}

main().catch((err) => {
  writeLine({ type: "error", message: String(err) });
  process.exit(1);
});
