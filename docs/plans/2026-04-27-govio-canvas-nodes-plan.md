# Govio Canvas 自动节点创建 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 当 LLM 运行 govio-cli observe 命令或回答中包含 SQL 代码块时，自动在 Canvas 前端创建对应的 sqlQuery / dataFrame / report 节点，并建立从用户引用节点到新节点的数据血缘边。

**Architecture:** 后端通过 pi-coding-agent Extension API 拦截 tool_result 和 message_end 事件，解析 govio-cli observe 的 JSON 输出和 SQL 代码块，将节点数据推入共享内存队列。ws-handler 在每个事件循环后 flush 队列，通过 WebSocket 发送 govio_node_create 事件给前端。前端 Canvas Store 收到事件后创建节点、建边、autoLayout。Parquet 预览数据不走 agent，由前端通过独立的 HTTP API 直接读取。

**Tech Stack:** pi-coding-agent Extension API (TypeBox, ExtensionAPI), WebSocket (ws), Vite dev server middleware, React + Zustand, @xyflow/react, @dagrejs/dagre, Python (pandas for parquet reading)

**Design doc:** docs/plans/2026-04-27-govio-canvas-nodes-design.md

---

## Key Reference Files

| File | Why |
|---|---|
| server/agent.ts | Session creation, DefaultResourceLoader config, extensionFactories |
| server/ws-handler.ts | WebSocket event subscription and forwarding pattern |
| server/index.ts | Vite plugin setup, HTTP server creation |
| server/govio-node-queue.ts | Shared memory queue (push/flush) - already created |
| src/store/canvas-store.ts | Zustand store, node/edge creation, sendMessage flow |
| src/services/ai-service.ts | WebSocket client, StreamEvent types, event dispatch |
| src/types/index.ts | Node data types (SQLQueryNodeData, DataFrameNodeData, ReportNodeData) |
| src/utils/layout.ts | Dagre auto-layout |
| .pi/skills/observe-dataset-ops/SKILL.md | observe load/list/show-datasource/release JSON output formats |
| .pi/skills/observe-compare-dfs/SKILL.md | observe compare JSON output format |
| .pi/skills/observe-explore-relations/SKILL.md | observe explore JSON output format |

## Extension API Notes

Extension = function (pi: ExtensionAPI) => void. Key APIs:

- pi.on("tool_result", handler) - event has toolName, input (Record with command for bash), content (array of {type:"text",text:string}), isError
- pi.on("message_end", handler) - event.message is AssistantMessage with content array containing {type:"text",text:string} blocks
- BashToolCallEvent input: { command: string, timeout?: number }
- ToolResultEvent base: input: Record<string, unknown>, content: (TextContent | ImageContent)[]
- Register via DefaultResourceLoader({ extensionFactories: [(pi) => ...] })

---

### Task 1: Verify Govio Node Queue

**Files:** server/govio-node-queue.ts (already exists)

**Step 1:** Read server/govio-node-queue.ts and confirm:
- GovioNodeType = "sqlQuery" | "dataFrame" | "report"
- GovioNodeCreateEvent with: nodeType, title, sql?, outputColumns?, dfName?, sourceName?, totalRows?, totalColumns?, memoryUsage?, columns?, reportType?, content?, sourceRefs?
- NO previewData field (preview data fetched via separate HTTP API)
- pushGovioNode() and flushGovioNodes() functions

**Step 2:** Commit

    git add server/govio-node-queue.ts
    git commit -m "feat: add govio-node-queue shared memory queue"

---

### Task 2: Parquet Preview HTTP API

**Files:**
- Create: server/parquet-api.ts
- Modify: server/index.ts

observe load produces .govio/observe/dataframes/{dfName}.parquet. Frontend calls GET /api/preview?df={dfName}&rows=10 to fetch first N rows as JSON via Python pandas.

**Step 1:** Create server/parquet-api.ts

The file should export a function `handleParquetApi(req: IncomingMessage, res: ServerResponse): boolean`:
- Returns false if req.url does not start with "/api/preview" (pass through)
- Parses query params: df (required), rows (optional, default 10)
- Validates parquet file exists at `.govio/observe/dataframes/{dfName}.parquet`
- Executes python3 with pandas to read parquet and output JSON
- Returns JSON array of records

**Step 2:** Modify server/index.ts

Add HTTP request handler to the createServer call:
- Import handleParquetApi from "./parquet-api.js"
- Create server with request listener that tries handleParquetApi first, 404 otherwise
- Log message updated to "WebSocket + API server"

**Step 3:** Verify TypeScript compiles

Run: npx tsc -b --noEmit
Expected: No errors

**Step 4:** Commit

    git add server/parquet-api.ts server/index.ts
    git commit -m "feat: add parquet preview HTTP API for DataFrame data"

---

### Task 3: Govio Canvas Extension

**Files:**
- Create: server/extensions/govio-canvas.ts

Core Extension that intercepts agent events and pushes node data into the queue.

**Step 1:** Create server/extensions/govio-canvas.ts

The extension handles two events:
1. **tool_result** - detects govio-cli observe bash commands, parses JSON stdout
2. **message_end** - extracts SQL code blocks from assistant messages

Key logic for tool_result:
- Filter toolName === "bash" and !event.isError
- Check input.command matches /govio-cli\s+observe/
- Parse subcommand via regex: load, compare, explore (ignore list, show-datasource, release)
- For load: extract name+datasource from command args, JSON.parse stdout, push dataFrame event with columns from column_info
- For compare: extract source+target from command args, JSON.parse stdout, push report (diff) event
- For explore: JSON.parse stdout, push report (correlation) event from relations array

Key logic for message_end:
- Extract text from event.message.content (filter type==="text" blocks)
- Find SQL code blocks using regex /```sql\s*\n([\s\S]*?)```/gi
- For each block: extract SELECT columns, push sqlQuery event

Helper functions needed:
- extractBashCommand(input) -> string
- extractTextContent(content) -> string (joins text blocks)
- parseObserveSubcommand(cmd) -> string | null
- parseLoadArgs(cmd) -> {name, datasource} | null
- parseCompareArgs(cmd) -> {source, target} | null
- handleLoadResult(cmd, stdout) - parse JSON, push dataFrame event
- handleCompareResult(cmd, stdout) - parse JSON, push report event
- handleExploreResult(stdout) - parse JSON, push report event
- formatCompareResult(parsed) -> markdown string
- formatExploreResult(relations) -> markdown string
- extractExploreSources(relations) -> Array<{label}>
- estimateMemoryUsage(rows, cols) -> string like "38.2 KB"
- extractSqlCodeBlocks(text) -> Array<{sql, outputColumns}>
- extractSelectColumns(sql) -> string[] (parse SELECT ... FROM)
- extractAssistantText(message) -> string

Import from "../govio-node-queue.js": pushGovioNode, GovioNodeCreateEvent
Import from "@mariozechner/pi-coding-agent": ExtensionAPI
Export default function govioCanvasExtension(pi: ExtensionAPI): void

**Step 2:** Verify TypeScript compiles

Run: npx tsc -b --noEmit
Expected: No errors

**Step 3:** Commit

    git add server/extensions/govio-canvas.ts
    git commit -m "feat: add govio-canvas Extension for auto node creation"

---

### Task 4: Register Extension in agent.ts

**Files:**
- Modify: server/agent.ts

**Step 1:** Add extensionFactory to DefaultResourceLoader

Add import at top:
    import govioCanvasExtension from "./extensions/govio-canvas.js";

Add extensionFactories to DefaultResourceLoader constructor:
    const loader = new DefaultResourceLoader({
      extensionFactories: [
        (pi) => { govioCanvasExtension(pi); },
      ],
      skillsOverride: (current) => { ... existing code unchanged ... },
    });

**Step 2:** Verify TypeScript compiles

Run: npx tsc -b --noEmit
Expected: No errors

**Step 3:** Commit

    git add server/agent.ts
    git commit -m "feat: register govio-canvas Extension in agent session"

---

### Task 5: Modify ws-handler.ts to flush node queue

**Files:**
- Modify: server/ws-handler.ts

**Step 1:** Import flushGovioNodes and add flush logic

Add import:
    import { flushGovioNodes } from "./govio-node-queue.js";

In the session.subscribe callback, add flush calls after tool_execution_end and message_end:

For tool_execution_end case, after the existing ws.send for tool_end:
    for (const node of flushGovioNodes()) {
      ws.send(JSON.stringify({ type: "govio_node_create", ...node }));
    }

For message_end case, after the existing ws.send for message_end:
    for (const node of flushGovioNodes()) {
      ws.send(JSON.stringify({ type: "govio_node_create", ...node }));
    }

**Step 2:** Verify TypeScript compiles

Run: npx tsc -b --noEmit
Expected: No errors

**Step 3:** Commit

    git add server/ws-handler.ts
    git commit -m "feat: flush govio node queue via WebSocket on tool_end and message_end"

---

### Task 6: Add govio_node_create event to frontend ai-service.ts

**Files:**
- Modify: src/services/ai-service.ts

**Step 1:** Extend StreamEvent type

Add "govio_node_create" to the type union. Add optional fields for govio node data:
- nodeType?: "sqlQuery" | "dataFrame" | "report"
- title?: string
- sql?: string
- outputColumns?: string[]
- dfName?: string
- sourceName?: string
- totalRows?: number
- totalColumns?: number
- memoryUsage?: string
- columns?: Array<{ name: string; nonNull: number; dtype: string }>
- reportType?: "diff" | "correlation"
- reportContent?: string  (use reportContent, NOT content, to avoid clash with text_delta's content field)
- sourceRefs?: Array<{ label: string }>

The WebSocket onmessage handler already forwards all JSON fields via cb(data), so no change needed there.

**Step 2:** Commit

    git add src/services/ai-service.ts
    git commit -m "feat: add govio_node_create event type to StreamEvent"

---

### Task 7: Add createGovioNode to canvas-store.ts

**Files:**
- Modify: src/store/canvas-store.ts

**Step 1:** Add state and action to CanvasStore interface

Add to interface:
    lastReferencedNodes: ReferencedNode[];
    createGovioNode: (event: StreamEvent) => void;

Add initial state:
    lastReferencedNodes: [],

**Step 2:** Save referencedNodes before sending message

In sendMessage, after `const { messages, referencedNodes } = get();`, add:
    set({ lastReferencedNodes: [...referencedNodes] });

This saves the current references before they get cleared. The lastReferencedNodes persists until the next sendMessage call overwrites it.

**Step 3:** Implement createGovioNode action

The action should:
1. Switch on event.nodeType to construct the correct Node type (sqlQuery, dataFrame, report)
2. Use nextId("gov") for node IDs
3. For dataFrame nodes, set previewData to [] (fetched on-demand via /api/preview)
4. For report nodes, use event.reportContent (not event.content) for the content field
5. Create edges from each lastReferencedNodes entry to the new node (deduplicate)
6. Add new nodes and edges, call getLayoutedElements, update state

**Step 4:** Add govio_node_create handling in sendMessage subscribe

Add a new case in the subscribe callback switch:
    case "govio_node_create":
      get().createGovioNode(event);
      break;

**Step 5:** Verify TypeScript compiles

Run: npx tsc -b --noEmit
Expected: No errors

**Step 6:** Commit

    git add src/store/canvas-store.ts
    git commit -m "feat: add createGovioNode action and lastReferencedNodes to canvas store"

---

### Task 8: Final verification

**Step 1:** Run full TypeScript check

    npx tsc -b --noEmit

**Step 2:** Run linter

    npm run lint

**Step 3:** Run dev server and verify no startup errors

    npm run dev

Expected: Server starts on port 5173, WebSocket+API on port 5174, no errors in console.
