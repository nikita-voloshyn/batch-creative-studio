---
component: Page
source: app/page.tsx
agent: frontend
updated: 2026-06-28
---

# Page

## Purpose
The main route (component C1): a Server Component static shell — an ALL-CAPS masthead and a one-line lede — that hosts the interactive client island `StudioShell` (uploader + params form + Generate).

## Public Interface
- `default Page()` — the `/` route Server Component.

## Inputs and Outputs
- Renders `<main class="content">` with a `<header class="masthead">` (title + meta), a `<p class="lede section">` instructional line, and `<StudioShell />`.
- No props, no data fetching.

## Dependencies
- `@/components/StudioShell` — the interactive client island.
- `app/globals.css` (via the layout) — the editorial visual language / class names.

## Key Decisions
- Server Component shell with a single client island keeps the static masthead/lede out of the hydration bundle while isolating interactivity to `StudioShell`.

## Known Limitations
- Copy and structure are fixed in markup (no CMS/config).
