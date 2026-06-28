# Plan: Batch Creative Studio — MVP

**Status:** Approved
**Date:** 2026-06-26
**Author:** Nikita + backend (primary domain agent)
**Approach:** Iterative + Timeboxing
**Phase:** MVP build (covers development-plan.md phases 1–8)

## Goal

Ship the MVP of Batch Creative Studio: upload N product images (≤20) + 1–2 reference images → batch-generate N styled social posts with progressive (SSE) rendering, retries, Gemini→Cloudflare failover, partial-failure handling, style consistency, and export — deployed on Vercel. Reliability and style consistency are first-class; persistence, durable queue, and Replicate are out of scope.

## Tasks

| # | Task | Domain | Depends on | Timebox | Acceptance criteria |
|---|------|--------|------------|---------|---------------------|
| 1 | **Scaffold & toolchain + shared types** — Next.js App Router, TS, pnpm, Biome, Vitest, `next.config` (Fluid Compute), `.env.example`, folder skeleton; `lib/types.ts` (Job/Item/Attempt/AspectRatio + SSE event payloads — the shared contract, BE-authored, read by all) | backend | none | 1d | `pnpm install`, `pnpm build`, `pnpm exec vitest run` all green; `lib/types.ts` exports the entity + event contract from architecture §7 and compiles |
| 2 | **Upload UI + validation + visual-language base** — app shell (`layout`/`page`), editorial/charcoal visual language (spec §5.2.1), Uploader (product N≤20 + reference 1–2, client validation format/size/resolution, previews + per-file removal), ParamsForm (aspectRatio, brief, perImageHints); direct-to-Blob upload wired against the `/api/uploads` contract | frontend | 1 | 2–3d | User selects/previews/removes product+reference images; invalid files rejected client-side; params captured; visual language matches §5.2.1 |
| 3 | **Upload endpoint** — `POST /api/uploads`: signed Vercel Blob upload, server-side content-type/size enforcement, `kind: product\|reference` | backend | 1 | 1d | Returns `{ uploadUrl, blobUrl }`; rejects wrong type/oversize; client uploads directly to Blob |
| 4 | **Provider abstraction + Gemini adapter** — `ImageProvider` interface, Gemini 2.5 Flash Image adapter (native reference conditioning), provider/model/quota/RPM/seed config, registry + chain, reference normalization, prompt/style-text builder | providers | 1 | 2–3d | Gemini implements `ImageProvider`; generates styled image from product+reference; `prompt.ts` composes brief + resolved `perImageHints[productImageUrl]` + style-text; config drives chain/quota |
| 5 | **Orchestrator + retry engine + state** — job orchestrator, bounded worker pool (`POOL_SIZE` 4–6), in-memory job/item/attempt store, retry engine (backoff+jitter, retry-vs-fatal classification), per-provider token-bucket rate limiter, idempotency (de-dup key + per-item result key `results/{jobId}/{itemId}.{ext}` last-writer-wins), event bus | backend | 1, 4 | 3d | Consumes `ImageProvider` registry; processes N items concurrently with retries; Terminal invariant holds within one function lifetime; unit-testable with a fake provider |
| 6 | **Job API + SSE server stream** — `POST /api/jobs` (validation, per-IP rate-limit, SSRF check on URLs, idempotency-key, create job+items, distribute `perImageHints`, derive seed, start orchestrator), `GET /api/jobs/:id` (snapshot), `GET /api/jobs/:id/stream` (SSE `ReadableStream`, events `item.status`/`item.result`/`item.error`/`job.progress`/`job.done`, `Last-Event-ID`), `POST /api/jobs/:id/items/:itemId/retry` | backend | 5 | 3d | Endpoints match architecture §7 contracts; SSE streams progressive events; reconnect via `Last-Event-ID` + snapshot |
| 7 | **Batch grid + progressive tiles + SSE client** — grid of N optimistic placeholders, per-`itemId` tile state machine (queued→running→succeeded\|failed), prompt-only badge, error + Retry, SSE client (`EventSource`, `Last-Event-ID` reconnect, snapshot merge, client store read-model), global progress `X/N` + error count | frontend | 2, 6 | 3d | Tiles render progressively from SSE; reconnect loses no results; targeted retry works; responsive reflow (NFR-7) |
| 8 | **Cloudflare adapter (+ Replicate optional)** — Cloudflare Workers AI adapter (FLUX.2 klein edit / schnell / SDXL), correct `supportsImageReference` flags; Replicate adapter behind config flag (off by default) | providers | 4 | 2d | Cloudflare implements `ImageProvider`; `supportsImageReference` accurate; Replicate present but flagged off |
| 9 | **Failover engine + partial-failure + degradation** — failover engine over `ImageProvider` (Gemini→Cloudflare→optional Replicate), exhaustion → `item.failed`, job aggregation (`completed` \| `completed_with_errors`), prompt-only degradation marking (`usedImageReference=false`) surfaced to SSE for the badge, quota-based pre-switch | backend | 5, 8 | 2d | Provider exhaustion fails over; all-exhausted → `failed`; job aggregates partial failures; degradation flagged; verified with forced fake-provider failures |
| 10 | **Fake provider + reliability test suite** — fake `ImageProvider` (timeout/429/fatal/empty-200/slow); unit tests: retry engine (backoff/jitter, classification), failover (chain/exhaustion), adapter mappers; integration: `POST /api/jobs` → stream → terminal states; boundary test | testing | 4, 5, 9 | 2–3d | Deterministic reliability tests pass; `pnpm exec vitest run` green; reliability core covered |
| 11 | **Export + status labels/badges** — single full-res download + whole-batch zip; ALL-CAPS status labels, prompt-only badge styling; final visual-language pass | frontend | 7 | 1d | Download single + zip works; labels/badges per visual language |
| 12 | **Security review — backend** — review-only: SSRF (outbound fetch of provider-returned + user blob URLs), input validation (upload + job creation), rate limiting `POST /api/jobs`, server-only secrets, file-upload safety, sensitive-data logging; Context7 (Next.js, Vercel Blob, provider SDKs) + OWASP cross-check | security-backend | 3, 6, 9 | 1–2d | Written finding in `docs/security/backend.md` + approval line; no critical unmitigated issue |
| 13 | **Deploy + integration smoke** — Vercel project, env wiring, Fluid Compute for the stream, preview-per-push / prod-on-main; manual E2E (real Gemini batch + forced primary failure → Cloudflare → prompt-only badge) | backend | 6, 7, 8, 11 | 1–2d | Preview deploy green; manual E2E passes; `/deploy-check` clean |

## Risks

- **SSRF on outbound fetch (high).** The server fetches provider-returned URLs and user-supplied blob URLs. Must validate/allowlist hosts and block private ranges. Covered by T12; T6 implements the guard. *To be Context7-verified at execution (Next.js fetch / SSRF mitigation).*
- **Provider & platform API shapes unverified at plan time (flagged).** Gemini 2.5 Flash Image edit request, Cloudflare Workers AI image request, Vercel Blob signed *client* upload, and Next.js Route Handler SSE via `ReadableStream` must be Context7-verified during T3/T4/T6/T8 (per each agent's research gate) before coding. Not yet verified here.
- **Vercel function timeout on long batches.** Fluid Compute + the streaming handler keep one batch alive within a single function lifetime; the Terminal invariant is conditional on process survival. Durable queue is the full-product fix (deferred).
- **Gemini daily free quota (~500/day).** Exhaustion forces prompt-only degradation; mitigated by quota-based pre-switch (T9) + the degradation badge.
- **Cloudflare schnell/SDXL are text-only.** Reduced style fidelity in fallback; mitigated by the prompt-only badge + style-text in the prompt. Replicate IP-Adapter is the full-product remedy.
- **Vitest ↔ Next.js Route Handler test setup.** Confirm config/harness at T1/T10 (Context7 Vitest).

## Out of scope (MVP)

- Authentication / multi-user isolation.
- Persistence (Postgres/Neon + KV/Upstash), batch history, permalinks.
- Durable queue (in-flight orchestration only for MVP).
- Replicate enabled by default (adapter built but flagged off).
- Extended observability dashboards / external OTLP sink (basic structured logs + metrics only).
- Component documentation via `/docs` (post-MVP).
- `fal.ai` / OpenAI providers.
