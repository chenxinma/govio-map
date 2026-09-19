# Design System: Green Deck (Light)

> The dark-mode Green Deck spec lives in `green-deck-DESIGN.md`. The production app uses a **light variant** described here.

## Overview

A clean, high-contrast light theme built for data-governance tooling. Brand green (`#1DB954`) provides identity accents on a neutral off-white canvas. Typography is DM Sans + JetBrains Mono (Google Fonts).

## Color Tokens

All tokens are defined in `src/index.css` (`@theme`) and consumed via Tailwind CSS v4 utilities.

### Backgrounds

| Token | Hex | Usage |
|-------|-----|-------|
| `bg-primary` | `#ffffff` | Cards, messages, inputs |
| `bg-canvas` | `#f5f5f5` | Page background, canvas |
| `bg-surface` | `#f0f0f0` | Surfaces, code blocks, input fields |
| `bg-card` | `#ffffff` | Node cards |

### Brand

| Token | Hex | Usage |
|-------|-----|-------|
| `brand` | `#1DB954` | Edges, handles, accents, active states |
| `brand-link` | `#1ED760` | Hover state |
| `brand-border` | `rgba(29,185,84,0.3)` | Subtle green border accent |

### Text

| Token | Hex | Usage |
|-------|-----|-------|
| `text-primary` | `#121212` | Headlines, titles |
| `text-secondary` | `#535353` | Body text |
| `text-muted` | `#727272` | Labels, metadata |
| `text-dim` | `#a7a7a7` | Hints, timestamps |

### Borders

| Token | Hex | Usage |
|-------|-----|-------|
| `border-subtle` | `#ececec` | Internal dividers |
| `border-default` | `#d4d4d4` | Card borders, inputs |
| `border-prominent` | `#b3b3b3` | Emphasized borders |
| `border-light` | `#a3a3a3` | Handles, light separators |

### Semantic

| Token | Hex | Usage |
|-------|-----|-------|
| `warning` | `#F59B23` | Offline, storage warnings |
| `error` | `#E22134` | Failures, destructive actions |
| `success` | `#1DB954` | Reuses brand green |

### Node Colors

| Token | HSL | Node Type |
|-------|-----|-----------|
| `node-source` | `hsl(270,60%,60%)` | SourceTable (purple) |
| `node-sql` | `hsl(152,58%,52%)` | SQLQuery (green) |
| `node-df` | `hsl(25,75%,55%)` | DataFrame (orange) |
| `node-chart` | `hsl(200,70%,55%)` | Chart (blue) |

Report nodes use amber-400 (diff) or violet-400 (correlation) from Tailwind.

## Typography

| Role | Font | Size | Weight | Notes |
|------|------|------|--------|-------|
| Hero / Page Title | DM Sans | 32px | 700 | Tight tracking |
| Section Title | DM Sans | 24px | 700 | |
| Card Title | DM Sans | 16px | 700 | Node titles |
| Body | DM Sans | 14px | 400 | |
| Body Small | DM Sans | 12px | 400 | |
| Label | DM Sans | 11px | 700 | Uppercase, 0.1em tracking |
| Code | JetBrains Mono | 13px | 400 | SQL, column names, data |

## Elevation

Light theme uses surface brightness (darker = lower) and subtle borders:

| Level | Surface | Border | Use |
|-------|---------|--------|-----|
| 0 (canvas) | `#f5f5f5` | — | Page background |
| 1 (card) | `#ffffff` | `#d4d4d4` | Node cards, panels |
| 2 (surface) | `#f0f0f0` | `#ececec` | Code blocks, inputs |
| 3 (overlay) | `#ffffff` | `#b3b3b3` | Modals, dropdowns |

## Edges & Handles

- Edge stroke: `#1DB954`, width 2, animated dash
- Edge hover/selected: `#1ED760`, width 4
- Handle: 8px circle, `#1DB954` fill, 2px white border

## Spacing

Base unit: 8px. Scale: 4, 8, 12, 16, 24, 32, 48, 64px.

## Border Radius

- 2px: Track list items
- 3px: Scrollbar thumb, inline code
- 4px: Inputs
- 6px: Code blocks, dropdowns
- 8px: Cards, modals
- 9999px: Pills, chips, search bar

## Scrollbar

- Width: 6px
- Track: transparent
- Thumb: `#c8c8c8`, 3px radius
- Thumb hover: `#b3b3b3`

## Do's and Don'ts

- **Do** use `#1DB954` for interactive accents (edges, handles, active states, links)
- **Do** use surface brightness for elevation (lighter = higher)
- **Don't** use green for large surface fills — it's an accent, not a background
- **Don't** add heavy box-shadows — use border color differences instead
- **Do** keep text high-contrast (`#121212` on `#ffffff`)
- **Do** use DM Sans 11px uppercase for section labels
