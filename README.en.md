# Govio Map

**English** | [简体中文](README.md)

Infinite-canvas data governance tool. Drive an AI agent (based on [pi-coding-agent](https://github.com/earendil-works/pi)) through natural-language conversation to run data queries, exploration, and analysis; results are arranged as visual card nodes on a canvas with data-lineage edges created automatically.

```
SourceTable ──▶ SQL ──▶ DataFrame ──▶ Report / Chart
```

## Getting Started

### Prerequisites

- **Node.js** (LTS)
- **[uv](https://docs.astral.sh/uv/)**: the installer for `govio-cli`. The first-run wizard installs/upgrades `govio-cli` and downloads skills through uv automatically — no manual install needed
- An API key for at least one AI provider (entered in the wizard; no hand-edited config files needed)

### Run with one command

```bash
npx govio-map
```

Open `http://localhost:5173/` in your browser (the terminal prints `Govio Map ready at http://localhost:5173`). Frontend (5173) and backend (5174, HTTP + WebSocket) start together; runtime data is written to `~/.govio/`.

### First-run wizard

On a fresh environment the **first-run wizard** pops up automatically; it can be reopened any time — it is idempotent and resumable, always reflecting real state and never overwriting completed steps:

1. **Environment check**: auto-repairs `govio-cli` / skills gaps with progress reporting
2. **Configure LLM**: pick OpenAI / Anthropic / DeepSeek / Gemini / custom (baseUrl + API protocol), enter the API key and "Test model" instantly; no default vendor lock-in
3. **Initialize the graph**: ladybug one-click by default (local embedded `~/.govio/ontology.lbdb`, zero external dependencies); falkordb / networkx available as advanced options
4. **Add a data source**: URL / password form + "Test connection", skippable/deferrable; on Windows use **two-slash** drive paths `duckdb://D:/...` (a third slash is parsed as a POSIX path and fails)
5. **Done**: the empty state shows next-best-actions (import metadata → ask your first data question)

### Credential safety

- Credentials are entered only through GUI forms, stored encrypted on this machine (`~/.govio/config.yaml`, `~/.pi/agent/models.json`) and **never sent to the LLM**
- Pasting a connection string or plaintext password into chat is intercepted by the backend and redirected to the data-source form ("credentials go through forms only" is a hard product constraint, see `docs/tasks/X34-onboarding-gui/design.md`)

## Developing from source

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables (optional)

For development you may create a `.env` in the project root with API keys (normal use goes through the first-run wizard). pi-coding-agent reads credentials via `ModelRuntime`, in priority order: runtime override > `~/.pi/agent/auth.json` > environment variables:

```bash
ANTHROPIC_API_KEY=sk-ant-xxxxx
# or OPENAI_API_KEY / GEMINI_API_KEY / MISTRAL_API_KEY
```

Credentials can also be persisted in `~/.pi/agent/auth.json`.

### 3. Start the dev server

```bash
npm run dev
```

- Vite frontend: `http://localhost:5173/`
- Backend (HTTP + WebSocket): port `5174` (= Vite port + 1)
  - `ws://localhost:5174/ws` — chat channel
  - `ws://localhost:5174/canvas` — canvas node stream
  - `GET /api/preview?df=<name>&rows=<n>` — DataFrame preview (reads `.govio/observe/dataframes/*.parquet`)

The Chat panel connects to `/ws` automatically. **There is no Mock AI fallback anymore** — when the backend is disconnected, the input is disabled with a "Not connected to server" notice.

Other scripts: `npm run build` (type-check + build), `npm run preview`, `npm run serve` (serve the packaged build — same entry as `npx govio-map`), `npm run ask -- -m "message"` (one-shot CLI chat, `-n` starts a new session, see `server/cli.ts`).

## How It Works

```
ChatPanel ──(/ws)──▶ ws-handler ──▶ agent.ts (pi AgentSession)
                                       │  govio-canvas extension (tools + event hooks)
                                       ▼
                       govio-node-queue (buffer, flushed at message_end / tool_end)
                                       │ (/canvas)
                       canvas-service ──▶ canvas-store.createGovioNode()
```

1. The user types a command in ChatPanel → `useChat.send()` sends `{type:"prompt", content, referencedNodes}` over `/ws`.
2. `ws-handler` serializes referenced nodes as a `REF:[...]` prefix prepended to the prompt, then calls pi `session.prompt()` (or `session.steer()` to interject while streaming).
3. pi events stream back: `agent_start` / `message_start` / `text_delta` / `thinking_delta` / `tool_start` / `tool_end` / `message_end` / `agent_end`.
4. The `govio-canvas` extension intercepts bash tool results and `message_end`: it parses SQL code blocks, `govio-cli observe load/compare/explore` results, and chart configs into `GovioNodeCreateEvent`s, queued and flushed to `/canvas`.
5. `canvas-service` receives the events → `canvas-store.createGovioNode()` creates ReactFlow nodes, auto-connects edges based on `referencedNodes` / `sourceRefs`, and positions them incrementally via `positionNewNode`.

pi-coding-agent (`@earendil-works/pi-coding-agent`) is the embedded AI coding-agent SDK that handles conversation reasoning, streaming, built-in file/shell tools, skills, and permission hooks. This project registers the `govio_create_source_table` / `govio_show_chart` tools and event hooks through its extension mechanism to bridge agent behavior to the canvas. See `docs/pi/` for the SDK and JSON protocol.

## Interacting

### Chat & streaming

Type natural language in the Chat panel (e.g. "summarize customer invoices by region", "analyze the correlation between invoices and payments"). The agent streams its reply with collapsible Thinking blocks and tool-call pills. Sending another message mid-stream interjects via `steer`.

### Referencing nodes in chat

Click **Reference** at the bottom of a card to add the node as a tag in the input; the referenced node's data (SQL text / DataFrame name / table schema) is appended to the prompt as context for the agent.

### Slash commands

Type `/` to trigger command suggestions:

- **Built-in**: `/clear` (reset session), `/clear-canvas` (clear canvas + messages), `/export` (export session as JSON)
- **Custom** (prompt templates from `src/data/commands.json`): `/sql`, `/analyze`, `/release-df`

### Node search

Use the search bar at the top of the canvas to find nodes by title; Enter cycles through matches and centers the view.

### DataFrame preview

Click **Preview** on a DataFrame card to open a draggable floating panel showing real data with pagination (parquet via `/api/preview`).

### Chart zoom

Click a Chart card to enlarge it; press Esc to close.

### Edges

Drag from a node's right output port to another node's left input port to create an edge; new nodes are also auto-connected based on reference relations.

### Permission confirmation

When the agent runs a `govio-cli observe load` data-export command with `-o` / `--output`, a permission card appears with **Allow / Accept All / Edit / Deny**. After Accept All, exports are auto-approved for the rest of the session; requests time out (5 minutes) and are auto-denied.

## Node Types

| Type | Accent color | Content | Created by |
|------|------|------|----------|
| SourceTable | Purple left border | Table name, database, fields (PK/FK) | `govio_create_source_table` tool |
| SQL | Green left border | SQL statement, output columns (double-click to edit) | SQL blocks extracted at `message_end` / manual creation from toolbar |
| DataFrame | Orange left border | df.info summary, preview | Parsed from `govio-cli observe load` results |
| Report | Amber (diff) / Purple (correlation) | Diff comparison or correlation report | Parsed from `observe compare` / `observe explore` |
| Chart | Blue left border | Plotly chart (zoomable) | `govio_show_chart` tool |

## Layout

Data lineage flows left to right with Dagre auto-layout (`network-simplex`); manual dragging and snap-to-grid (15px) are supported. Canvas state is persisted to localStorage (`govio-canvas-state`) and survives refreshes.

## Tech Stack

| Category | Technology |
|------|------|
| Framework | React 19 + TypeScript |
| Build | Vite |
| Canvas | @xyflow/react (ReactFlow) |
| State | Zustand (persist → localStorage) |
| Layout | @dagrejs/dagre |
| Styling | Tailwind CSS v4 |
| Charts | Plotly |
| AI Agent | @earendil-works/pi-coding-agent |
| Communication | WebSocket (ws) |
| Data | hyparquet (parquet reading) |
| Icons / Markdown | Lucide React / react-markdown |

## Project Structure

```
server/                       # Backend (Vite plugin, port 5174)
├── index.ts                  # Vite plugin entry, starts http + WS servers
├── agent.ts                  # pi AgentSession management (in-memory session, skill filtering, govio-cli check)
├── ws-handler.ts             # /ws and /canvas handling, event forwarding, permission responses
├── parquet-api.ts            # /api/preview parquet reading
├── permission-manager.ts     # Data-export permission confirmation (allow/deny/edit/accept-all)
├── govio-node-queue.ts       # Node-creation event buffering and flushing
├── cli.ts                    # Standalone CLI for `npm run ask`
└── extensions/
    └── govio-canvas.ts       # pi extension: govio tools + tool_call/tool_result/message_end hooks

src/
├── components/
│   ├── Canvas/               # ReactFlow canvas, toolbar, node search bar, floating preview
│   ├── Nodes/                # SourceTable/SQL/DataFrame/Report/Chart(+Modal) nodes
│   ├── Chat/                 # Chat panel, input, messages, permission cards
│   └── Layout/               # Header + canvas/chat two-pane layout + drag divider
├── commands/                 # Slash-command system (built-in + custom prompt templates)
├── hooks/                    # useChat (/ws client), useChatContext
├── services/                 # canvas-service (/canvas client), mock-ai (ID utilities)
├── store/                    # canvas-store (Zustand)
├── data/                     # mock-tables, commands.json
├── types/                    # Node / event type definitions
└── utils/                    # layout (dagre incremental + full layout)

.pi/                          # pi config: APPEND_SYSTEM.md + skills (govio / govio-query / govio-observe / govio-eda / govio-meta)
docs/pi/                      # pi-coding-agent SDK and JSON protocol docs
```

## Design System

Light "Green Deck" theme (Spotify-inspired); full spec in `docs/green-deck-DESIGN.md`:

- Backgrounds: `#f5f5f5` (page/canvas), `#ffffff` (cards/messages), `#f0f0f0` (surfaces/inputs)
- Brand green: `#1DB954` (used for accents, edges, and highlights), hover `#1ED760`
- Border levels: `#ececec` -> `#d4d4d4` -> `#b3b3b3`; no box-shadow
- Fonts: DM Sans (body) + JetBrains Mono (code), loaded from Google Fonts
