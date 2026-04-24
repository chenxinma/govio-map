# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Govio Map is an infinite canvas data governance tool. Users issue natural language commands to generate SQL queries, DataFrames, and reports that appear as nodes on a canvas with directed edges representing data lineage.

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
1. User sends message via `ChatPanel` → `useCanvasStore.sendMessage()`
2. If WebSocket connected + no node refs: streams via `ai-service.ts` (pi-coding-agent)
3. Otherwise: `mock-ai.ts` generates fixed responses based on pattern matching
4. New nodes/edges are created and auto-layouted via `dagre`

### State Management (`src/store/canvas-store.ts`)
Single Zustand store owns all canvas state: nodes, edges, messages, referenced nodes, preview panels.

### Node Types (`src/types/index.ts`)
- `sourceTable`: Database table with schema (purple left border)
- `sqlQuery`: SQL statement (green left border)
- `dataFrame`: pandas-style dataframe info (orange left border)
- `report`: diff or correlation analysis (amber/purple left border)

### Backend (`server/index.ts`)
Vite plugin that runs WebSocket server for pi-coding-agent sessions. Auto-fallback to Mock mode if not connected.

### Key Files
- `src/components/Canvas/Canvas.tsx` — ReactFlow canvas with drag/drop, connections
- `src/components/Nodes/*.tsx` — Custom node components with handles
- `src/services/ai-service.ts` — WebSocket client + mock fallback
- `src/services/mock-ai.ts` — Rule-based response generation
- `src/data/mock-tables.ts` — 8 mock business tables with schemas
- `src/utils/layout.ts` — Dagre auto-layout for directed graphs

## Design System

Dark theme based on Supabase:
- Background: `#171717` (page), `#0f0f0f` (buttons)
- Brand green: `#3ecf8e` (edges, accents)
- Text: `#fafafa` (primary), `#b4b4b4` (secondary), `#898989` (muted)
- Borders define depth: `#242424` → `#2e2e2e` → `#363636`
- No shadows — borders only

## Environment Variables

Create `.env` with at least one AI provider:
```bash
ANTHROPIC_API_KEY=sk-ant-xxxxx
# or OPENAI_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY
```

## Technical Stack

React 18 + TypeScript, Vite, @xyflow/react (ReactFlow), Zustand, @dagrejs/dagre, Tailwind CSS v4, @mariozechner/pi-coding-agent, WebSocket (ws)
