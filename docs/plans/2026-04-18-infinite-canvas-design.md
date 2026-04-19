# Infinite Canvas Data Governance App - Design Document

## Overview

A Supabase-themed infinite canvas application for data governance. Users query data via natural language in a chat panel, and results are visualized as connected nodes on an infinite canvas (ReactFlow). The canvas serves as a visual data lineage map.

## Tech Stack

| Category | Technology | Version |
|----------|-----------|---------|
| Framework | React | ^18.2.0 |
| Language | TypeScript | ^5.0.0 |
| Build | Vite | ^5.0.0 |
| Canvas | React Flow | ^11.10.0 |
| Layout | Dagre | ^0.8.5 |
| State | Zustand | ^4.5.0 |
| Styling | Tailwind CSS | ^3.4.0 |
| Icons | Lucide React | latest |

## Design System (Supabase Dark Theme)

Strictly following `docs/DESIGN.md`:

### Colors
- Background: `#0f0f0f` (deepest), `#171717` (page/canvas)
- Text: `#fafafa` (primary), `#b4b4b4` (secondary), `#898989` (muted)
- Brand: `#3ecf8e` (green accent), `#00c573` (links)
- Borders: `#242424` (subtle), `#2e2e2e` (standard), `#363636` (prominent)
- Green border: `rgba(62, 207, 142, 0.3)`
- Depth via border hierarchy, NO box-shadows
- Radix colors for node types: purple (source table), violet (SQL), orange (DataFrame)

### Typography
- Primary: Inter (Circular substitute), weight 400 for everything, 500 for interactive
- Monospace: Source Code Pro for technical labels (uppercase, 1.2px letter-spacing)
- No bold (700)

### Components
- Buttons: pill (9999px) for primary, 6px for secondary
- Cards/Nodes: 8px radius, `#171717` bg, `#2e2e2e` border
- Tabs: pill shape

## Layout

```
┌──────────────────────────────────────────────┐
│  Header (56px)                               │
├──────┬───────────────────────────────────────┤
│      │                                       │
│ Side │         Infinite Canvas               │
│ bar  │         (ReactFlow)                   │
│ 280  │                                       │
│ px   │                                       │
│      │                                       │
├──────┴───────────────────────────────────────┤
│  Chat Panel (320px, resizable, collapsible)  │
└──────────────────────────────────────────────┘
```

## Data Model

### Node Types

1. **SourceTable** - Purple left border, shows table name, DB, row count, field list (max 6 visible)
2. **SQLQuery** - Green left border, shows SQL preview, dialect, execution status, output columns
3. **DataFrame** - Orange left border, shows Python code preview, columns, row count

### Mock Data (8 tables)

billing, customer, department, sales_group, product, billing_item, region, payment

### Mock AI Logic

Keyword matching: "账单金额" → returns billing/customer/department/sales_group + GROUP BY SQL

## Core Interaction Flow

1. User types natural language in Chat
2. Mock AI returns required tables + SQL
3. Canvas creates SourceTable nodes + SQLQuery node + edges (tables → SQL)
4. Dagre auto-layout arranges nodes
5. User clicks [引用] on SQL node → Chat input gets `[⚡SQL#1]` snap tag
6. User types "取数加载 dataframe" and sends
7. Canvas creates DataFrame node + edge (SQL → DataFrame)

## File Structure

```
src/
├── components/
│   ├── Canvas/
│   │   └── Canvas.tsx
│   ├── Nodes/
│   │   ├── SourceTableNode.tsx
│   │   ├── SQLQueryNode.tsx
│   │   ├── DataFrameNode.tsx
│   │   └── index.ts
│   ├── Chat/
│   │   ├── ChatPanel.tsx
│   │   ├── MessageList.tsx
│   │   └── ChatInput.tsx
│   ├── Sidebar/
│   │   └── Sidebar.tsx
│   └── Layout/
│       ├── Header.tsx
│       └── AppLayout.tsx
├── store/
│   └── canvas-store.ts
├── services/
│   └── mock-ai.ts
├── data/
│   └── mock-tables.ts
├── types/
│   └── index.ts
├── utils/
│   └── layout.ts
├── styles/
│   └── tokens.css
├── App.tsx
└── main.tsx
```
