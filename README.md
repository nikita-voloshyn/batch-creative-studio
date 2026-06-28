# Batch Creative Studio

Upload **N product images + 1–2 reference images**, hit **Generate**, and get **N social posts** styled to the reference — rendered **progressively** as each one lands. Built for reliability at scale: **retries, multi-provider failover, and a steady visual style** across the batch.

> Engineering-challenge submission. Stack: **Next.js (App Router) + Vercel · TypeScript · pnpm**. Single-user, no auth.

---

## Example — one batch, one consistent look

One **reference** sets the mood; three very different product photos come back as a cohesive set. The reference's mood is read **once per job** by a vision model, then each product is re-lit to match it — the product itself is left untouched.

**Reference (style / mood):**

<img src="docs/examples/reference.jpg" width="200" alt="style reference">

> Mood the vision model extracted from it: *"soft, diffused lighting; warm, muted beige and creamy tones with a subtle golden warmth; a desaturated, slightly vintage grade; a simple, seamless backdrop; calm, minimalist, understated elegance."*

| Product image (input) | → | Generated post (output) |
|:---:|:---:|:---:|
| <img src="docs/examples/product-1.jpg" width="200"> | → | <img src="docs/examples/output-1.jpg" width="200"> |
| <img src="docs/examples/product-2.jpg" width="200"> | → | <img src="docs/examples/output-2.jpg" width="200"> |
| <img src="docs/examples/product-3.jpg" width="200"> | → | <img src="docs/examples/output-3.jpg" width="200"> |

Each product keeps its exact shape, materials, and controls — the clock display, the wireless-charging pad, the wood grain and linen shade — while the harsh blue / clinical-white backgrounds are replaced by the reference's warm, seamless mood. The **same** look lands on all three, which is the "steady visual style across every output" the brief asks for.

> Generated live through this app's pipeline (HuggingFace FLUX.1-Kontext). Free models vary run-to-run; this is a representative batch.

---

## Quick start

```bash
pnpm install
cp .env.example .env.local      # then fill in the keys below
pnpm dev                        # http://localhost:3000
```

**Minimum to generate (free):** a HuggingFace token. It powers both the product-preserving edit **and** the once-per-job reference-mood read; the chain falls over to Cloudflare automatically.

| Var | What | Where |
|---|---|---|
| `HF_TOKEN` | **Primary** — FLUX.1-Kontext img2img (preserves the product) **+** the vision model that reads the reference's mood | [hf.co/settings/tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) — fine-grained, "Inference Providers" permission |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | Fallback — Workers AI | dash.cloudflare.com → Workers AI |
| `BLOB_READ_WRITE_TOKEN` | Uploads + results | Vercel → Storage → Blob (a **public** store) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Shared state for multi-instance prod (optional locally) | Vercel → Storage → Upstash for Redis |
| `PROVIDER_CHAIN` | `huggingface,cloudflare` (default) | — |

> Adapters for **Gemini**, **Pollinations**, and **Replicate** also ship behind the same interface — off by default, drop-in via `PROVIDER_CHAIN`.

Then: drop in product photos + a reference, write a one-line brief (the scene/mood), **Generate**.

---

## How it works

```
Browser ── upload (signed, direct-to-Blob) ──► Vercel Blob
   │  POST /api/jobs (create N items, SSRF-checked, rate-limited)
   └─ GET /api/jobs/:id/stream (SSE) ──► hosts the orchestrator (Fluid Compute)
                                          │
        provider abstraction ◄── failover engine ◄── retry engine ◄── worker pool
        (Kontext → Cloudflare)        (backoff+jitter)   (bounded concurrency)
```

- **Provider abstraction** (`lib/providers`): every model is an `ImageProvider` adapter behind one interface. The **failover engine** (`lib/orchestrator/failover.ts`) consumes only that interface and advances the chain.
- **Reliability core**: retries with exponential backoff + jitter and error classification; per-provider token-bucket rate limiting; idempotent, last-writer-wins result keys; partial-failure aggregation (one bad item never sinks the batch).
- **Progressive rendering**: each result streams to its own tile over SSE the moment it's ready, with `Last-Event-ID` reconnect + snapshot recovery.
- **Shared state**: in-memory locally; **Upstash Redis** (env-gated) in production so any serverless instance sees the job.

Deep dives: [`docs/architecture.md`](docs/architecture.md) · [`docs/product-flow.md`](docs/product-flow.md) · decisions in [`docs/state/decisions.md`](docs/state/decisions.md) · per-component docs in [`docs/components/`](docs/components/).

---

## Providers & the honest output story

The brief asks for posts **styled to the reference** that **preserve the product** — two requirements that pull against each other on *free* models:

| Provider | Preserves the product (img2img)? | Free? |
|---|---|---|
| **HuggingFace FLUX.1-Kontext** (primary) | ✅ true image-edit — keeps the product, restyles per the prompt | tiny free credit, then ~cents/image |
| Cloudflare Workers AI (FLUX/SDXL) | ⚠️ weak at composition | 10k neurons/day |
| Gemini 2.5 Flash Image ("Nano Banana") | ✅ best — native multi-image conditioning | paid (free image-gen limit = 0) |
| Pollinations `gptimage` | ❌ text-to-image (ignores the input image) | unlimited |

**The hard part — and the judgment call.** Kontext preserves the product but is **single-image**: it can't take a *second* image (the reference) as a style input. The obvious hack — compositing product + reference **side-by-side** into one frame — I tried and **rejected**: Kontext intermittently ignored the reference, echoed its objects into the result, or returned a collage. Unreliable is worse than absent.

The shipped approach instead **reads the reference's *mood* with a vision model once per job** (`google/gemma-3-27b-it` on HF → "dramatic warm directional light, teal-and-orange cinematic grade, cozy/mysterious atmosphere…", objects deliberately omitted), then runs a **product-only** Kontext edit conditioned on that text. Result: the product is preserved exactly, the reference's mood is applied **consistently across the whole batch**, and there's **zero reference-leak** (nothing but the product is ever in frame). Pixel-exact reference matching wants a paid IP-Adapter/Gemini model — a one-env-var swap behind the same interface — but for "match the mood," vision-to-text is the right free, reliable call. See [`docs/state/decisions.md`](docs/state/decisions.md).

---

## What I built vs. deliberately left out

**In scope (and done):** upload + validation, batch generation with bounded concurrency, the reliability core (retries · **Kontext → Cloudflare failover**, proven live · partial-failure · targeted retry), **reference-mood transfer via once-per-job vision extraction → product-only edit**, progressive SSE rendering with reconnect, style consistency (shared prompt + per-batch seed + the same extracted mood across the batch), export (single + zip), editorial visual language, server-side secrets + SSRF guards + rate limiting, **Upstash Redis** shared state for multi-instance prod, and a Vercel deploy.

**Deliberately deferred (full-product, not half-day):** auth/multi-user, batch history/permalinks, a durable queue (the SSE handler hosts orchestration in-flight), cross-instance SSE pub/sub for mid-batch reconnects, and enabling Replicate. Each is noted in `docs/state/decisions.md` with the reasoning — the point was a working, reliable batch with clear trade-offs, not gold-plating.

---

## How this was built (AI tooling)

Built with **Claude Code** running a **multi-agent workspace** (the `forgeline` plugin): domain agents (`frontend` / `backend` / `providers` / `testing` / `security-backend`) under a supervisor, driven through a **`/plan` → `/assign` → `/execute`** pipeline with a **fresh-context reviewer** after every implementer task and an adversarial multi-dimension review at the end. The audit trail lives in [`docs/plans/`](docs/plans/) (plan, dispatch, report) and [`docs/reviews/`](docs/reviews/); a `security-backend` review is in [`docs/security/`](docs/security/). Each task was verified (lint · types · 106 tests · build) before moving on, and contract divergences (e.g. Vercel Blob's real upload API, the seed INT32 range, the free-provider reality) were caught by live testing and folded back in.

---

## Verify

```bash
pnpm exec biome check .      # lint + format
pnpm exec tsc --noEmit       # types
pnpm exec vitest run         # 106 tests (reliability core: retry, failover, idempotency, adapters)
pnpm build                   # production build
```

Tests concentrate on the reliability core (deterministic, fake-provider-driven), matching the challenge's "test coverage matters less" weighting — they exist where a regression would actually hurt.

## Deploy

Vercel (`vercel --prod`). Set the env vars above on the project (the Blob + Upstash integrations inject theirs automatically). Fluid Compute keeps the SSE stream alive; the Blob store must be **public** (image URLs are rendered + fetched directly).

---

## Time spent

<!-- TODO (author): fill in actual time -->
`~__h` of focused engagement.

## Repo map

```
app/ components/ lib/        — the app (UI · API routes · providers · orchestrator · state)
docs/architecture.md         — technical architecture
docs/product-flow.md         — end-to-end behavior / state machines
docs/state/decisions.md      — every load-bearing decision + trade-off
docs/components/             — per-component reference docs
docs/plans/ docs/reviews/    — the AI build audit trail
```
