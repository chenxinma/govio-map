# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Govio Map is an infinite canvas data governance tool. Users issue natural language commands that drive an AI agent (pi-coding-agent) to generate SQL queries, DataFrames, reports, and charts that appear as nodes on a canvas with directed edges representing data lineage.

```
Tables ──▶ SQL ──▶ DataFrame ──▶ Report
```

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
- `chart`: chart.js visualization (blue left border)

### Backend (`server/index.ts`)
Vite plugin (`server/index.ts`) runs HTTP + WebSocket on port 5174: `/ws` (chat), `/canvas` (node stream), `/api/preview` (parquet). `server/agent.ts` manages an in-memory pi `AgentSession` with the `govio-canvas` extension. Requires `govio-cli` on PATH; no mock fallback (disconnected state disables input).

### Key Files
- `server/index.ts` — Vite plugin: HTTP + WS server on port 5174 (`/ws`, `/canvas`, `/api/preview`)
- `server/agent.ts` / `server/extensions/govio-canvas.ts` — pi AgentSession + govio tools & event hooks
- `server/ws-handler.ts` / `server/permission-manager.ts` — WS handling, event forwarding, permission flow
- `src/hooks/useChat.ts` / `src/services/canvas-service.ts` — /ws & /canvas clients
- `src/store/canvas-store.ts` / `src/components/Nodes/*.tsx` — Zustand canvas state + nodes (incl. chart.js)
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

React 19 + TypeScript, Vite, @xyflow/react (ReactFlow), Zustand, @dagrejs/dagre, Tailwind CSS v4, chart.js, @earendil-works/pi-coding-agent, hyparquet, WebSocket (ws)

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%)
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->