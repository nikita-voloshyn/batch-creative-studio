# Batch Creative Studio — Development Plan

> Use `/plan` to start a new feature, `/phase` for phase-level execution.

**Development Approach:** Iterative + Timeboxing

## Phases

Each phase is a 1–3 day deliverable cycle. At the end of every cycle the app must be in a usable (even if incomplete) state. Update the **Status** column as you progress: `Pending` → `In Progress` → `Done`.

| # | Phase (Deliverable) | Status | Timebox |
|---|---------------------|--------|---------|
| 1 | Upload + validation: signed Vercel Blob uploads, product (N≤20) + reference (1–2), client + server validation (format/size/resolution), previews with per-file removal | Pending | 2 days |
| 2 | Provider abstraction + Gemini adapter: `ImageProvider` interface, Gemini 2.5 Flash Image adapter (native image reference), provider/quota config | Pending | 2 days |
| 3 | Job orchestrator + retry engine: bounded-concurrency worker pool (4–6), in-memory job/item/attempt store, backoff + jitter retries, error classification, idempotency | Pending | 3 days |
| 4 | Progressive rendering: SSE server stream (event bus → ReadableStream), client batch grid of independent tiles, reconnect via `Last-Event-ID` / snapshot | Pending | 3 days |
| 5 | Failover: Cloudflare Workers AI adapter (secondary), failover engine over `ImageProvider`, prompt-only degradation badge, partial-failure handling | Pending | 2 days |
| 6 | Reliability tests: retry engine (backoff/jitter, classification), failover logic, adapter mappers, fake provider, integration (`POST /api/jobs` → stream → terminal states) | Pending | 2 days |
| 7 | Export + visual language: single-post download + batch zip, editorial/utilitarian-brutalist styling, status labels, prompt-only badge | Pending | 1 day |
| 8 | Deploy: Vercel (Fluid Compute for the stream), env wiring, preview-per-push / production-on-main | Pending | 1 day |

## Notes

- Update the **Status** column as you progress: `Pending` → `In Progress` → `Done`
- Each phase can be broken into sub-tasks using `/plan`
- Use `/phase` for phase-level execution, or `/plan` → `/assign` → `/execute` for feature-level orchestration
- All feature plans and reports are saved in `docs/plans/`
- Replicate (tertiary provider), persistence (Postgres/Neon + KV/Upstash), a durable queue, batch history/permalinks, and extended observability are **full-product scope** — deliberately deferred (see README §9 / TZ §15)
