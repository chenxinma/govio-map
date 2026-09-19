# AGENTS.md

## Project Overview

Govio Map is an infinite canvas data governance tool. Users issue natural language commands that drive an AI agent (pi-coding-agent) to generate SQL queries, DataFrames, reports, and charts that appear as nodes on a canvas with directed edges representing data lineage.

```
Tables ──▶ SQL ──▶ DataFrame ──▶ Report
```

## Govio 资源路径的实际位置

skills/govio/assets = ./.agents/skills/govio/assets

## Commands

```bash
npm run dev      # Start Vite dev server (port 5173) + WebSocket (port 5174)
npm run build    # TypeScript check + Vite build
npm run lint     # ESLint
npm run preview  # Preview production build
```

## Architecture

### Data Flow
1. User sends message via `ChatPanel` → `useChat.send()` over WS `/ws`
2. `server/ws-handler.ts` prepends referenced-node context and calls pi `session.prompt()` (or `session.steer()` while streaming)
3. pi events stream back; the `govio-canvas` extension parses tool results / `message_end` into `GovioNodeCreateEvent`s, flushed over WS `/canvas`
4. `canvas-service` -> `canvas-store.createGovioNode()` creates nodes + auto-edges, positioned via `positionNewNode` (dagre)

### State Management (`src/store/canvas-store.ts`)
Single Zustand store owns canvas state: nodes, edges, referenced nodes, preview panels (persists to localStorage `govio-canvas-state`). Chat messages live in `useChat`.

### Node Types (`src/types/index.ts`)
- `sourceTable`: Database table with schema (purple left border)
- `sqlQuery`: SQL statement (green left border)
- `dataFrame`: pandas-style dataframe info (orange left border)
- `report`: diff or correlation analysis (amber/violet left border)
- `chart`: Plotly visualization (blue left border)

### Backend (`server/index.ts`)
Vite plugin (`server/index.ts`) runs HTTP + WebSocket on port 5174: `/ws` (chat), `/canvas` (node stream), `/api/preview` (parquet). `server/agent.ts` manages an in-memory pi `AgentSession` with the `govio-canvas` extension. Requires `govio-cli` on PATH; no mock fallback (disconnected state disables input).

### Key Files
- `server/index.ts` — Vite plugin: HTTP + WS server on port 5174 (`/ws`, `/canvas`, `/api/preview`)
- `server/agent.ts` / `server/extensions/govio-canvas.ts` — pi AgentSession + govio tools & event hooks
- `server/ws-handler.ts` / `server/permission-manager.ts` — WS handling, event forwarding, permission flow
- `server/govio-installer.ts` — govio-cli 安装与技能包下载
- `src/hooks/useChat.ts` / `src/services/canvas-service.ts` — /ws & /canvas clients
- `src/store/canvas-store.ts` / `src/components/Nodes/*.tsx` — Zustand canvas state + nodes (incl. Plotly)
- `src/commands/` / `src/utils/layout.ts` — slash-command system + dagre layout

## Design System

Light "Green Deck" variant (Spotify-inspired); see docs/green-deck-DESIGN.md. Tokens in src/index.css (@theme):
- Background: `#f5f5f5` (page/canvas), `#ffffff` (cards/messages), `#f0f0f0` (surfaces/inputs)
- Brand green: `#1DB954` (edges, accents), hover `#1ED760`
- Text: `#121212` (primary), `#535353` (secondary), `#727272` (muted), `#a7a7a7` (dim)
- Borders: `#ececec` (subtle) → `#d4d4d4` (default) → `#b3b3b3` (prominent) → `#a3a3a3` (light)
- Semantic: warning `#F59B23`, error `#E22134`, success `#1DB954`; fonts DM Sans + JetBrains Mono (Google Fonts); elevation via surface brightness (lighter = higher)

## Environment Variables

Create `.env` with at least one AI provider. Also requires `govio-cli` on PATH (external CLI, validated at backend startup):
```bash
ANTHROPIC_API_KEY=sk-ant-xxxxx
# or OPENAI_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY
```

## Technical Stack

React 19 + TypeScript, Vite, @xyflow/react (ReactFlow), Zustand, @dagrejs/dagre, Tailwind CSS v4, plotly.js, @earendil-works/pi-coding-agent, hyparquet, WebSocket (ws)
