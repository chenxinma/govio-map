import { getOrCreateSession, agentSetup } from "./agent.js";
import { ModelRuntime, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "node:util";
import { createWriteStream, type WriteStream } from "node:fs";

type MessageEvent = Extract<AgentSessionEvent, { type: "message_start" | "message_end" }>;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const { values } = parseArgs({
  options: {
    message: { type: "string", short: "m" },
    raw: { type: "boolean", short: "r" },
    output: { type: "string", short: "o" },
    new: { type: "boolean", short: "n" },
    model: { type: "string" },
    thinking: { type: "string" },
  },
  strict: true,
});

const message = values.message;
if (!message) {
  console.error('Usage: tsx server/cli.ts -m "your question" [-n|--new] [-o output.json] [--model provider/id] [--thinking level]\n  -n, --new            start a new session instead of continuing the most recent one\n  --model provider/id  model for this run (overrides the session-restored model)\n  --thinking level     thinking level: off|minimal|low|medium|high|xhigh|max');
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

  const opts: NonNullable<Parameters<typeof getOrCreateSession>[1]> = {};
  if (values.model) {
    const sep = values.model.indexOf("/");
    const provider = sep > 0 ? values.model.slice(0, sep) : "";
    const modelId = sep > 0 ? values.model.slice(sep + 1) : "";
    if (!provider || !modelId) {
      console.error("--model 需为 provider/id 形式，如 --model deepseek/deepseek-v4-flash");
      process.exit(1);
    }
    const model = (await ModelRuntime.create()).getModel(provider, modelId);
    if (!model) {
      console.error(`未找到模型: ${values.model}`);
      process.exit(1);
    }
    opts.model = model;
  }
  if (values.thinking) {
    if (!THINKING_LEVELS.has(values.thinking)) {
      console.error(`--thinking 需为 ${[...THINKING_LEVELS].join("/")} 之一`);
      process.exit(1);
    }
    opts.thinkingLevel = values.thinking as NonNullable<typeof opts.thinkingLevel>;
  }

  const session = await getOrCreateSession(values.new, opts);

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
            content += delta;
            out.write(JSON.stringify(delta).slice(1, -1));
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

  await session.prompt(message!);
}

main().catch((err) => {
  writeLine({ type: "error", message: String(err) });
  if (values.output) (out as WriteStream).end();
  process.exit(1);
});
