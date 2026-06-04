import { getOrCreateSession, agentSetup } from "./agent.js";
import { parseArgs } from "node:util";
import { createWriteStream, type WriteStream } from "node:fs";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

type MessageEvent = Extract<AgentEvent, { type: "message_start" | "message_end" }>;

const { values } = parseArgs({
  options: {
    message: { type: "string", short: "m" },
    raw: { type: "boolean", short: "r" },
    output: { type: "string", short: "o" },
  },
  strict: true,
});

const message = values.message;
if (!message) {
  console.error('Usage: tsx server/cli.ts -m "your question" [-o output.json]');
  process.exit(1);
}

const out: WriteStream | typeof process.stdout = values.output
  ? createWriteStream(values.output, { flags: "w" })
  : process.stdout;

function writeLine(obj: unknown) {
  out.write(JSON.stringify(obj) + "\n");
}

async function main() {
  await agentSetup();
  const session = await getOrCreateSession();

  let inMessage = false;
  let content = "";

  const unsubscribe = session.subscribe((event) => {
    if (values.raw) {
      writeLine(event);
    } else {
      switch (event.type) {
      case "message_start":
        if ((event as MessageEvent).message.role === "assistant") {
          inMessage = true;
          content = "";
          out.write('{"type":"streaming","content":"');
        }
        break;
      case "message_update":
        if (inMessage) {
          if (event.assistantMessageEvent.type === "text_delta" || event.assistantMessageEvent.type === "thinking_delta") {
            const delta = event.assistantMessageEvent.delta;
            for (const ch of delta) {
              content += ch;
              out.write(ch === '"' ? '\\"' : ch === "\n" ? "\\n" : ch);
            }
          }
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
          out.write('","length":' + content.length + '}\n');
          inMessage = false;
          content = "";
        }
        break;
      case "agent_end":
        unsubscribe();
        if (values.output) (out as WriteStream).end();
        process.exit(0);
      }
    }
  });

  await session.prompt(message);
}

main().catch((err) => {
  writeLine({ type: "error", message: String(err) });
  if (values.output) (out as WriteStream).end();
  process.exit(1);
});
