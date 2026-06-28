# Dispatch: Batch Creative Studio — MVP

**Plan:** `batch-creative-studio-mvp-plan.md`
**Date:** 2026-06-26
**Status:** Approved

## Execution Order

Groups define dependency order, not parallelism — execute one session at a time, top to bottom. An agent only ever writes inside its `owns` domain; cross-group dependencies are read/contract dependencies, never co-writes.

### Group 1 (independent)

| Task | Agent | Pre-skills | Post-skills | Status |
|------|-------|------------|-------------|--------|
| 1 · Scaffold & toolchain + shared types | `backend` | — | `/check` | Done |

### Group 2 (after Group 1)

| Task | Agent | Pre-skills | Post-skills | Status |
|------|-------|------------|-------------|--------|
| 2 · Upload UI + validation + visual-language base | `frontend` | read `docs/architecture.md` §2/§6, `docs/product-flow.md` §2 | `/check` | Done |
| 3 · Upload endpoint (`POST /api/uploads`) | `backend` | Context7: Vercel Blob signed client upload | `/check` | Done |
| 4 · Provider abstraction + Gemini adapter | `providers` | Context7: Gemini 2.5 Flash Image edit request shape | `/check` | Done |

### Group 3 (after Group 2)

| Task | Agent | Pre-skills | Post-skills | Status |
|------|-------|------------|-------------|--------|
| 5 · Orchestrator + retry engine + state | `backend` | read `docs/architecture.md` §5, `docs/product-flow.md` §3/§6/§7 | `/check` | Done |
| 8 · Cloudflare adapter (+ Replicate optional) | `providers` | Context7: Cloudflare Workers AI image generation | `/check` | Done |

### Group 4 (after Group 3)

| Task | Agent | Pre-skills | Post-skills | Status |
|------|-------|------------|-------------|--------|
| 6 · Job API + SSE server stream | `backend` | Context7: Next.js Route Handler SSE via `ReadableStream` | `/check` | Done |
| 9 · Failover engine + partial-failure + degradation | `backend` | read `docs/architecture.md` §4/§5, `docs/product-flow.md` §5 | `/check` | Done |

### Group 5 (after Group 4)

| Task | Agent | Pre-skills | Post-skills | Status |
|------|-------|------------|-------------|--------|
| 7 · Batch grid + progressive tiles + SSE client | `frontend` | Context7: `EventSource` / `Last-Event-ID` reconnect | `/check` | Done |
| 10 · Fake provider + reliability test suite | `testing` | read `docs/product-flow.md` §3/§5 | `/check` | Done |
| 12 · Security review — backend | `security-backend` | Context7 (Next.js / Vercel Blob / provider SDKs) + OWASP cross-check | `npx semgrep --config p/owasp-top-ten .` | Done |

### Group 6 (after Group 5)

| Task | Agent | Pre-skills | Post-skills | Status |
|------|-------|------------|-------------|--------|
| 11 · Export (single + zip) + status labels/badges | `frontend` | — | `/check` | Done |

### Group 7 (after Group 6)

| Task | Agent | Pre-skills | Post-skills | Status |
|------|-------|------------|-------------|--------|
| 13 · Deploy + integration smoke | `backend` | provision keys (`docs/state/open-questions.md`) | `/deploy-check`, `/changelog` | Done |

## Notes

- **Agent = the plan's domain owner for each task; no reassignments.** Every task's domain falls cleanly inside one agent's `owns` list — no ambiguous assignments to flag.
- **Load-bearing boundary (backend vs providers).** The failover **engine** (T9) and orchestrator (T5) are `backend`; the provider **adapters** (T4, T8) are `providers`. These are split across tasks precisely so a single task never co-writes both sides of the `ImageProvider` interface (CLAUDE.md single-writer rule). The engine consumes the interface; it never edits adapter internals.
- **Cross-domain contract dependencies are not co-writes.** T2 (`frontend`) builds the upload UI against the `POST /api/uploads` *contract* but T3 (`backend`) owns that route's source. T7 (`frontend`) consumes the SSE/`/api/jobs` contracts owned by T6 (`backend`). Frontend never writes `app/api/**`; backend never writes `components/**`.
- **Scaffold ownership.** T1 is `backend` because it establishes server-side build/config + the shared `lib/types.ts` contract (BE-authored, read by all). `frontend` takes over `app/(client)` + `components/**` from T2 onward.
- **Security task is trigger-driven (mandatory).** The feature matches multiple `/plan` security signals — file upload, outbound fetch / SSRF (server fetches provider-returned + user blob URLs), secrets/API keys, rate limiting. `security-backend` exists, so T12 is a dedicated review-only task depending on the implementer tasks it audits (T3, T6, T9). It writes only `docs/security/backend.md` — no source.
- **Research gate deferred to execution.** Provider/platform API shapes (Gemini edit, Cloudflare image, Vercel Blob signed upload, Next.js SSE) are unverified at plan time and are pinned as Context7 pre-skills on the exact tasks that need them (T3/T4/T6/T8). No assignment was made on an unverified API guess.
- **Replicate** adapter is built in T8 but config-flagged off; enabling it is full-product scope and needs `REPLICATE_API_TOKEN`.
