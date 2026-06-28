---
component: RootLayout
source: app/layout.tsx
agent: frontend
updated: 2026-06-28
---

# RootLayout

## Purpose
The Next.js App Router root layout (component C1): a static Server Component shell rendering `<html>`/`<body>` and exporting page metadata. Interactive surfaces hydrate as Client Components composed inside `app/page.tsx`.

## Public Interface
- `default RootLayout({ children })` — the root layout Server Component.
- `metadata: Metadata` — title "Batch Creative Studio" + description.

## Inputs and Outputs
- Renders `<html lang="en">` wrapping `<body suppressHydrationWarning>{children}</body>`.
- Imports `./globals.css` (the editorial visual language: white background, charcoal text, system sans, ALL-CAPS labels, thin separators).

## Dependencies
- `next` — `Metadata` type.
- `react` — `ReactNode` type.
- `app/globals.css` — visual language.

## Key Decisions
- `suppressHydrationWarning` on `<body>`: browser extensions (e.g. Grammarly) inject attributes onto `<body>` before React hydrates, which is harmless but would otherwise log a hydration mismatch.
- Kept as a pure static shell — no client logic at the layout level.

## Known Limitations
- None of note; intentionally minimal.
