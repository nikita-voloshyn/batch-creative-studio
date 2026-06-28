# Technical Architecture

> Batch Creative Studio — engineering architecture. This document **extends** the product spec (`README.md`, `docs/TZ.md`) and is kept **contract-consistent with the product-flow doc**; it does not replace or contradict either. Where a spec or the flow doc states a contract (interface shapes, event names, endpoints, env vars, storage keys, entity fields), this document treats it as authoritative and adds the concrete module decomposition, call directions, and ownership boundaries needed to build it.
>
> **Stack:** Next.js (App Router) + Vercel · pnpm · Vitest · Biome · single-user, no auth.
>
> **Ownership legend** (single-writer per module): `FE` frontend · `BE` backend · `PV` providers · `TS` testing. Every file in §12 has exactly one owner.
>
> **Cross-doc alignment (applied throughout):** pool-size config is `POOL_SIZE`; per-image hints are `perImageHints` (in `Job.params`); the result Blob key is the **per-item, attempt-independent** key `results/{jobId}/{itemId}.{ext}` (last-writer-wins — every successful attempt overwrites the same object); `POST /api/uploads` request is `{ filename, contentType, kind }` (no client-declared size); `POST /api/jobs/:id/items/:itemId/retry` returns `{ ok: true }`.
>
> **⚠️ Provider chain — shipped vs. as-designed (updated 2026-06-28).** The abstraction in this doc (the `ImageProvider` interface, failover engine, retry, rate-limit, SSE, state machine, ownership boundaries) is all **as-shipped**. The **concrete provider chain evolved during live testing**, so where this doc says "Gemini-first" read it as the *original design*: the shipped default is **`PROVIDER_CHAIN=huggingface,cloudflare`** with **HuggingFace FLUX.1-Kontext** as the product-preserving primary, and the reference's *mood* is applied via a **once-per-job vision-extraction step** (`lib/providers/style-extract.ts`) instead of image-conditioning. Gemini ("Nano Banana"), Pollinations, and Replicate ship as adapters behind the same interface but are **off by default**. Full reasoning: [`docs/state/decisions.md`](state/decisions.md) (2026-06-28) and the README's *Providers* section.

---

## 1. System context + high-level component diagram

Single browser session talks to Next.js Route Handlers running as Vercel Functions (Fluid Compute). Route Handlers are the **only** component holding secrets and the **only** component that talks to provider APIs, Blob, and the state store. The browser never sees a provider key, never calls a provider, and uploads bytes directly to Blob via a short-lived signed URL.

**Execution model (load-bearing, spec §5.3 baseline):** generation runs **inside the SSE stream handler**. `POST /api/jobs` only *creates* the Job + Items and returns `jobId`; the actual orchestration (worker pool, retries, failover) executes **within the `GET /api/jobs/:id/stream` invocation**, which therefore co-owns the orchestrator, the in-process event bus, and the SSE writer in one process. This is what makes the in-process bus reachable by the stream (see §6 and the contradiction it resolves).

```
                          BROWSER (single user, no auth)
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ Next.js Client Components                                                   │
 │  Uploader (product+ref)   Params form   Batch grid (responsive, progressive)│
 │  SSE client + reconnect   Zustand store  Export (single / zip)              │
 └─────┬──────────────┬──────────────┬───────────────────────┬────────────────┘
       │ (1) PUT bytes │ (2) POST     │ (3) GET  SSE          │ (4) GET snapshot
       │  to signed URL│  /api/jobs   │  /api/jobs/:id/stream  │  /api/jobs/:id
       │  (Blob)       │  (create only)│ (runs orchestrator)    │  POST .../retry
       │               │  POST         │                        │
       │               │  /api/uploads ▼                        ▼
       │      ┌──────────────────────────────────────────────────────────────┐
       │      │ NEXT.JS ROUTE HANDLERS  (Vercel Functions · Node runtime ·    │
       │      │                          Fluid Compute · server-only secrets) │
       │      │  app/api/uploads     → signed-upload token mint               │
       │      │  app/api/jobs        → create Job+Items, derive seed (no gen) │
       │      │  app/api/jobs/:id/stream → host orchestrator + SSE (one inv.)  │
       │      │  app/api/jobs/:id    → Job snapshot (reconnect recovery)      │
       │      │  app/api/.../retry   → CAS failed→queued, re-drive one Item   │
       │      │ ┌────────────────────────────────────────────────────────┐   │
       │      │ │ ORCHESTRATION (BE): worker pool · retry engine ·        │   │
       │      │ │ failover ENGINE · token-bucket limiter · event bus ·    │   │
       │      │ │ result-persist step · abort sweeper                     │   │
       │      │ └───────────────┬───────────────┬──────────────┬─────────┘   │
       │      │   failover consumes ImageProvider│              │             │
       │      │   orchestrator (composition root) builds inputs │             │
       │      └───────┬─────────────────────────┬┼──────────────┼─────────────┘
       │              │ (server fetch)          ││              │
       │   ┌──────────▼────────┐   ┌────────────▼▼──────────┐  ┌▼─────────────────┐
       └──▶│ VERCEL BLOB       │   │ PROVIDER ADAPTERS (PV) │  │ STATE STORE       │
           │ uploads/ (in)     │   │  1. Gemini 2.5 Flash   │  │ MVP: in-memory    │
           │ results/{itemId}   │  │  2. Cloudflare WAI     │  │  (per-process)    │
           │ signed, per-item LWW│  │  3. Replicate (opt.)   │  │ Full: Postgres+KV │
           └───────────────────┘   └────────────────────────┘  └───────────────────┘
                                            │ HTTPS to api.* (provider HTTP APIs)
```

**Trust boundary:** everything below the Route Handler band is server-only. The orchestration band contains two distinct seams: the **failover engine** consumes only the `ImageProvider` interface, while the **orchestrator (composition root)** builds inputs from PV modules. Both are enforced in the file layout (§4, §12) and an architecture test (§12 note).

---

## 2. Component inventory (mapped to the four agent owners)

| # | Component | Owner | Responsibility | Key files |
|---|---|---|---|---|
| C1 | App shell / layout | FE | Server Component static shell, visual language (spec §5.2.1), fonts | `app/layout.tsx`, `app/page.tsx`, `app/globals.css` |
| C2 | Uploader | FE | Drag&drop + picker, client validation (type/size/**resolution**), per-file preview/remove, calls `/api/uploads`, PUTs bytes to signed URL | `components/uploader/*`, `lib/client/uploadClient.ts` |
| C3 | Params form | FE | Aspect ratio, batch brief, per-image caption hint (builds `perImageHints` keyed by product URL) | `components/params/ParamsForm.tsx` |
| C4 | Batch grid + tiles | FE | N optimistic placeholders, per-`itemId` independent tile state machine, prompt-only badge, error+Retry, **responsive reflow (NFR-7, §2.1)** | `components/grid/*` |
| C5 | SSE client + reconnect | FE | `EventSource` subscribe, `Last-Event-ID` reconnect, snapshot merge, dispatch into store, handle reconnect-failure (cross-instance 404, §6.3) | `lib/client/sseClient.ts`, `lib/client/store.ts` |
| C6 | Export | FE | Single full-res download, whole-batch zip | `components/export/*`, `lib/client/zip.ts` |
| C7 | Uploads route | BE | Validate request `{filename,contentType,kind}`, mint signed Blob upload token constraining content-type + max size | `app/api/uploads/route.ts` |
| C8 | Jobs route (create) | BE | Validate payload, SSRF-check user URLs, **derive per-batch `seed`**, build `Job`+`Items` (status `queued`), persist, return `jobId`. **Does not start generation.** | `app/api/jobs/route.ts` |
| C9 | Stream route (SSE) | BE | **Host + start the orchestrator inline**, own the per-job event bus, open `ReadableStream`, replay since `Last-Event-ID`, heartbeat, abort-sweep on shutdown | `app/api/jobs/[id]/stream/route.ts` |
| C10 | Snapshot route | BE | Return `Job` snapshot for reconnect/direct open | `app/api/jobs/[id]/route.ts` |
| C11 | Retry route | BE | **Atomic CAS `failed→queued`** (dedups double-clicks; **idempotent `200` no-op** if not `failed`), re-enqueue one Item into the live pool or signal the client to reopen the stream | `app/api/jobs/[id]/items/[itemId]/retry/route.ts` |
| C12 | Job orchestrator (composition root) | BE | Owns a Job lifecycle: run `referenceNormalizer` once, build `prompt`, resolve `registry.chain()`, drive pool, persist results, aggregate terminal status, run abort sweeper | `lib/orchestrator/orchestrator.ts` |
| C13 | Worker pool | BE | Bounded concurrency `POOL_SIZE` (default 4–6) over the Item queue | `lib/orchestrator/pool.ts` |
| C14 | Retry engine | BE | Backoff+jitter schedule, **owns `kind`→decision classification** (retry vs advance vs fatal) | `lib/orchestrator/retry.ts` |
| C15 | Failover ENGINE | BE | Walk provider chain per Item; **consumes `ImageProvider` + neutral `ProviderError` facts only** | `lib/orchestrator/failover.ts` |
| C16 | Rate limiter | BE | Per-provider token bucket (RPM) + best-effort daily-quota pre-switch (§5.4) | `lib/orchestrator/rateLimiter.ts` |
| C17 | Idempotency | BE | `attemptHash = hash(itemId+attemptNumber)`, provider-call dedupe + per-item result key | `lib/orchestrator/idempotency.ts` |
| C18 | Event bus | BE | In-process pub/sub + per-job ring buffer (replay) feeding SSE | `lib/orchestrator/eventBus.ts` |
| C19 | Blob gateway | BE | Sign uploads, **fetch provider URLs when needed, persist result bytes** under the per-item key (`{ext}` from content-type) | `lib/blob/blob.ts` |
| C20 | State store | BE | CRUD on Job/Item/Attempt + atomic status CAS; in-memory (MVP) behind an interface | `lib/state/store.ts`, `lib/state/memoryStore.ts` |
| C21 | ImageProvider interface | PV | The contract: `id`, `supportsImageReference`, `generate(input, signal)` | `lib/providers/types.ts` |
| C22 | Gemini adapter | PV | Map contract → Gemini 2.5 Flash Image ("Nano Banana") multimodal edit | `lib/providers/gemini.ts` |
| C23 | Cloudflare adapter | PV | Map contract → Workers AI (FLUX.2 klein / FLUX.1 schnell / SDXL) | `lib/providers/cloudflare.ts` |
| C24 | Replicate adapter (opt.) | PV | Map contract → Replicate FLUX + Redux/IP-Adapter | `lib/providers/replicate.ts` |
| C25 | Provider registry/config | PV | Build ordered chain from env, quotas, model ids; validate chain at start | `lib/providers/registry.ts`, `lib/providers/config.ts` |
| C26 | Reference normalization | PV | One-time resize/encode of reference images, reused per Item | `lib/providers/referenceNormalizer.ts` |
| C27 | Prompt template | PV | Single shared template (image-cond + extracted-style text + brief + resolved per-image hint) | `lib/providers/prompt.ts` |
| C28 | Fake provider | TS | Controllable failures (timeout/429/fatal/slow) for deterministic tests | `test/fakes/fakeProvider.ts` |
| C29 | Test suites | TS | Unit (retry/failover/adapters), integration (job→stream), boundary test, **manual forced-failover E2E**, fixtures | `test/**` |
| X1 | Shared types | shared (BE-authored, read by all) | `Job`/`Item`/`Attempt`/**`AspectRatio` (canonical)**/event payloads | `lib/types.ts` |
| X2 | Logger/metrics | BE | Structured per-attempt logs, batch summary, OTel hook | `lib/observability/*` |

> **Boundary invariant (precise — two distinct BE→PV relationships, never conflated).**
> 1. **Failover engine** (`failover.ts`, C15) imports **only** the `ImageProvider` interface (C21) plus neutral `ProviderError` facts (`errors.ts`). It never imports a concrete adapter (C22–C24), never imports the registry, never builds inputs.
> 2. **Composition root / input builder** (`orchestrator.ts`, C12 — BE) has an **explicitly declared BE→PV non-interface dependency** on `registry.ts`/`config.ts` (resolve the ordered chain) and on `prompt.ts`/`referenceNormalizer.ts` (build `GenerateInput`). `retry.ts` (C14) imports `errors.ts` for `ProviderError.kind` and **owns** the `kind`→decision policy.
>
> Forbidden in all cases (grep-able in review/tests, §12 note): any `lib/orchestrator/**` importing a concrete adapter file; `failover.ts` importing the registry/prompt/normalizer; any `lib/providers/**` importing `lib/orchestrator/**` or a `lib/state/**` write API; any `app/api/**` importing a concrete adapter. Adapters import **no** BE module and perform HTTP only.

### 2.1 Frontend responsiveness (NFR-7)

`FE`. Desktop-first, working mobile. The batch grid (C4) is a CSS responsive grid (`grid-template-columns: repeat(auto-fill, minmax(…))`) that **reflows** column count by viewport: 3–4 columns desktop, 2 tablet, 1 phone. Uploader, params form, and export controls stack vertically under the max-width content column on narrow screens. Tiles keep a fixed aspect box (per `aspectRatio`) so reflow never causes layout jank while results stream in. No fixed pixel widths in the grid; the editorial/charcoal visual language (spec §5.2.1) is preserved at every breakpoint.

---

## 3. Layered architecture

Six layers. **Calls flow strictly downward.** A lower layer never imports an upper layer; sibling components within a layer do not import each other except via declared interfaces.

```
┌──────────────────────────────────────────────────────────────────┐
│ L1  CLIENT          (FE)  React Client Components, Zustand store,   │
│                          EventSource, fetch. Browser only.         │
└───────────────────────────────┬──────────────────────────────────┘
   HTTP / SSE + isomorphic schema │  (lib/types.ts + lib/validation/* only)
┌───────────────────────────────▼──────────────────────────────────┐
│ L2  API / ROUTE HANDLERS (BE)  app/api/**. Validate, SSRF-check,   │
│                          translate HTTP↔domain, HOST orchestration │
│                          inside the stream handler, open SSE.      │
└───────────────────────────────┬──────────────────────────────────┘
┌───────────────────────────────▼──────────────────────────────────┐
│ L3  ORCHESTRATION   (BE)  orchestrator(=composition root), pool,    │
│                          retry, FAILOVER ENGINE, rate limiter,      │
│                          idempotency, bus, result-persist, sweeper. │
└──────┬───────────────────────┬───────────────────────┬────────────┘
 failover│ ImageProvider iface  │ composition root:      │ Job/Item API
 (iface  │                      │ registry/prompt/norm   │
  only)  ▼                      ▼ (declared BE→PV)        ▼
┌──────────────────────────────────┐          ┌────────────────────────────┐
│ L4 PROVIDER ABSTRACTION (PV)       │          │ L6 STATE  (BE) store iface, │
│   types · errors(facts) · registry │          │   memory impl (MVP)/pg(full)│
│   config · adapters · prompt · norm│          └────────────┬───────────────┘
└──────────────┬─────────────────────┘                       │
   HTTPS + raw │ fetch of trusted app-origin                  │
   provider API│ Blob input URLs (no blob.ts import)          │
┌──────────────▼─────────────────┐                            │
│ L5 STORAGE (BE)  Blob gateway   │◀───────────────────────────┘
│   signed uploads, result persist│  (results persisted by L3)
└────────────────────────────────┘
```

**Allowed call directions (explicit):**

- **L1 → L2** over HTTP/SSE. The **only** shared module imports permitted across this boundary are **isomorphic, dependency-free** ones: `lib/types.ts` (DTO types) and `lib/validation/*` (zod schemas with no server-only imports). FE imports the validation schemas to mirror server constraints — single source of truth, defense in depth. No other server module crosses. (This amends the earlier "type-only" rule: pure schemas are explicitly allowed because they are isomorphic; the rule still forbids importing any module with server-only deps — secrets, providers, orchestrator, blob, state.)
- **L2 → L3, L2 → L6, L2 → L5.** Route handlers read state for snapshots (L6), mint Blob tokens (L5), and the **stream handler hosts/starts orchestration** (L3).
- **L3 split.** The **composition root** (`orchestrator.ts`) imports L4 non-interface modules (`registry`, `config`, `prompt`, `referenceNormalizer`), L5 (`blob`), and L6 (`state`). The **failover engine** (`failover.ts`) imports **only** the L4 `ImageProvider` interface and neutral `ProviderError` facts. The failover engine is the sole consumer of the interface; it never resolves the chain or builds inputs (the composition root does that and injects the resolved chain).
- **L4 adapters → external provider HTTP**, plus a raw `fetch` of the **trusted app-origin Blob input URLs** carried in `GenerateInput` (to inline image bytes for the provider request). Adapters import **no** BE module and never read/write Job/Item state. *(The previous "L4 → L5 read-only via `blob.ts`" arrow is removed — adapters need a URL fetch, not the Blob gateway.)*
- **L5, L6** terminal — call nothing upward.

Forbidden (grep-able in review): `lib/orchestrator/**` importing `lib/providers/gemini|cloudflare|replicate`; `lib/orchestrator/failover.ts` importing the registry/prompt/referenceNormalizer; `lib/providers/**` importing `lib/orchestrator/**` or `lib/state/**` write APIs; any `app/api/**` importing a concrete adapter; any adapter importing `lib/blob/**` or `lib/state/**`.

---

## 4. Provider abstraction layer

The interface and DTOs are **verbatim from the spec** (`README §4.3`, `TZ §5.4`). `AspectRatio` has **one canonical home — `lib/types.ts` (X1)** — and `lib/providers/types.ts` re-exports it (resolves the prior double-ownership). The failover engine (BE) is built against this interface and nothing else.

```ts
// lib/types.ts   (owner: X1 — canonical AspectRatio + domain entities)
export type AspectRatio = "1:1" | "4:5" | "9:16";

// lib/providers/types.ts   (owner: PV — the contract; re-exports AspectRatio)
export type { AspectRatio } from "../types";
import type { AspectRatio } from "../types";

export interface ImageProvider {
  id: string;                       // "gemini" | "cloudflare" | "replicate"
  supportsImageReference: boolean;  // drives style conditioning vs prompt-only
  generate(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult>;
}

export type GenerateInput = {
  productImageUrl: string;          // trusted app-origin Blob URL (not bytes)
  referenceImageUrls: string[];     // 1..2, already normalized (§ referenceNormalizer)
  prompt: string;                   // shared template + brief + resolved per-image hint (§ prompt)
  aspectRatio: AspectRatio;
  seed: number;                     // per-batch deterministic seed (from Job.seed, §5.6)
};

export type GenerateResult = {
  imageBytes: Uint8Array | string;  // raw bytes OR a provider URL (re-persisted by BE, §5.5)
  providerId: string;
  usedImageReference: boolean;      // false ⇒ prompt-only degradation badge
  meta: { latencyMs: number; model: string };
};
```

**Error contract — NEUTRAL FACTS ONLY (added for retry classification).** Adapters do not classify; they throw a typed error carrying only *facts*. The `kind`→retry/advance/fatal **policy lives solely in `retry.ts` (BE, §5.3)** — no decision annotations live in the providers package (resolves the policy-leak boundary issue).

```ts
// lib/providers/errors.ts   (owner: PV — neutral facts; NO policy)
export type ProviderErrorKind =
  | "rate_limit"      // HTTP 429
  | "server"          // HTTP 5xx
  | "timeout"         // network / aborted
  | "unavailable"     // provider "temporarily unavailable"
  | "auth"            // HTTP 401/403
  | "content_policy"  // moderation reject
  | "invalid_input"   // HTTP 4xx (non-429)
  | "quota_exhausted";// provider-reported daily cap

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,   // a fact, not a decision
    readonly providerId: string,
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,     // surfaced for retry engine; honored there
  ) { super(message); }
}
```

### Adapters (one per provider, all `PV`)

| Adapter | Model(s) | `supportsImageReference` | Mapping notes |
|---|---|---|---|
| `gemini.ts` | Gemini 2.5 Flash Image ("Nano Banana") | `true` | Multimodal edit: product image + 1–2 normalized references as inline image parts + prompt text + `seed`. Maps Google error bodies → `ProviderError`. Returns inline image bytes. |
| `cloudflare.ts` | FLUX.2 [klein] (edit) / FLUX.1 [schnell] / SDXL | `klein → true`, `schnell/SDXL → false` | Workers AI REST `accounts/:id/ai/run/@cf/...`. When the active model can't take an image reference, set `usedImageReference:false` and rely on the prompt's extracted-style text. Passes `seed` where supported. |
| `replicate.ts` (optional) | FLUX + Redux / IP-Adapter | `true` | Enabled only if `REPLICATE_API_TOKEN` set. Create prediction → poll/stream → **URL** result (re-persisted by the BE result-persist step, §5.5). |

### Registry & config (`PV`) + dependency-injection seam

```ts
// lib/providers/registry.ts   (owner: PV)
export interface ProviderRegistry {
  /** Ordered failover chain built from env; absent/uncredentialed providers omitted. */
  chain(): ImageProvider[];
  get(id: string): ImageProvider | undefined;
  quota(id: string): QuotaConfig;   // daily cap + RPM, env-driven (spec §6.4)
}
```

- Chain order and retry/quota limits come from `lib/providers/config.ts` (env), **not hardcoded** (spec §6.2/§6.4).
- **DI / composition seam (explicit owner).** The **`orchestrator.ts` (BE) is the composition root**: it imports `registry.ts`/`config.ts`, calls `registry.chain()` once per Job, and **injects the resolved `ImageProvider[]` into the failover engine**. The failover engine never names a registry or a concrete class. This is the declared, documented BE→PV non-interface dependency from §2/§3.
- **Empty / under-configured chain (edge case).** At job start the composition root validates `registry.chain()`. If length is **0** (no provider configured or none holds credentials), the Job fails fast: `Job.status = "failed"` with code `no_providers_configured`, `job.done {status:"failed"}` — no Items run (this is a legitimate job-level `failed`, §5.1). If length **≥1**, normal failover applies; an Item that exhausts a length-1 chain reaches `item.failed` (not a job failure).

### Reference normalization (`PV`)

`referenceNormalizer.ts`: one-time per Job — fetch 1–2 reference URLs, resize/re-encode to a provider-friendly bound (e.g. ≤ long-edge px, webp/png), cache the normalized handle, and pass it to every Item's `referenceImageUrls`. Avoids per-Item preprocessing cost (spec risk §16). **Invoked by the composition root** (declared BE→PV input-builder dependency), not by the failover engine.

- **Failure path (edge case).** If a reference is corrupt/oversized/unfetchable, normalization fails as a **job-level precondition failure**: `Job.status = "failed"`, code `reference_normalization_failed`, clear message; `job.done {status:"failed"}` is emitted and **no Items run**. (This is the only other legitimate `failed` case besides empty chain — §5.1.)

### Shared prompt template (`PV`)

`prompt.ts`: single template across the batch (basis of style consistency, spec §6.3). Composes: batch `brief` + the **resolved per-image caption hint** + a **textual description of the extracted reference style** (so prompt-only fallbacks still approximate the look). Returns the `prompt` string placed into `GenerateInput`. **Invoked by the composition root** per Item.

- **Per-image hint threading (resolves the "hint has no home" gap).** `Job.params.perImageHints?: Record<string, string>` is keyed by `productImageUrl`. When the composition root builds an Item's `GenerateInput`, it resolves `params.perImageHints?.[item.productImageUrl]` and passes that string to `prompt.ts`. The data model carries the hint (on `Job.params`, matching the flow doc) and the resolution path Item→prompt is fully defined; no new persisted `Item` field is required.

> **Restated boundary (load-bearing):** the **failover ENGINE lives in `lib/orchestrator/failover.ts` (backend)** and consumes only `ImageProvider` + injected chain + neutral `ProviderError` facts. The **adapters live in `lib/providers/**` (providers)**. Input building (prompt, normalization, chain resolution) is the **composition root's** job, not the engine's. They are separately ownable and separately testable.

---

## 5. Orchestration internals

All `BE`. Orchestration is **hosted inside the `GET /api/jobs/:id/stream` invocation** (spec §5.3): the same process owns the orchestrator, the in-process event bus + ring buffer, and the SSE writer. It emits events to the bus; the SSE writer is a co-located subscriber.

```
POST /api/jobs ─▶ validate · SSRF-check user URLs · derive seed
                 · materialize Job + N Items (status=queued) · persist · return {jobId}
                 (NO generation here)

GET /api/jobs/:id/stream  ─▶  (single long-lived invocation = orchestrator host)
   ├─ load Job from store; start orchestrator if not already running in this instance
   ├─ referenceNormalizer (once) ──fail──▶ Job.status=failed; job.done{failed}; close
   ├─ chain = registry.chain(); validate ──empty──▶ Job.status=failed; job.done{failed}
   ▼
   build Item queue (N)                                ┌── eventBus(jobId) ──▶ SSE writer
   ┌── worker pool (cap POOL_SIZE=4..6) ──┐            │  (publish + ring buffer, replay)
   │  for each free slot: take Item       │            │  publishes (with monotonic id):
   │   ▼                                  │            │   item.status / item.result
   │  failover.run(item, chain) ──────────┼── emits ──▶│   item.error  / job.progress
   │     for provider in chain:           │            │   job.done
   │       rateLimiter.take(pid)          │            │
   │       retry.loop:                    │            │
   │         idempotency.guard            │            │
   │         provider.generate()→bytes|url│            │
   │         blob.persistResult(...)      │  (fetch url if needed; ext from content-type)
   │         classify(ProviderError.kind) │            │
   │       advance on exhaust/fatal       │            │
   └──────────────────────────────────────┘            │
        │ on each terminal Item: state.update ──────────┘
        ▼
   aggregate ⇒ Job.status = completed | completed_with_errors
   on abort/shutdown ⇒ sweep non-terminal Items → failed(interrupted); emit job.done
```

### 5.1 Job orchestrator / composition root (`orchestrator.ts`)
Owns one Job: runs `referenceNormalizer` once, resolves `registry.chain()`, materializes the N queued Items into the queue, builds each `GenerateInput` (prompt + resolved hint + seed + normalized refs), hands Items to the pool, listens for terminal outcomes, persists results, emits `job.progress` after each Item and `job.done` at the end. Holds the per-Job `AbortController` for clean cancel on shutdown and runs the **abort sweeper** (§5.7).

**Aggregation rule (resolves "when does Job become `failed`?").**
- All Items `succeeded` ⇒ `completed`.
- Mix of `succeeded` and `failed` ⇒ `completed_with_errors`.
- **All Items `failed` ⇒ `completed_with_errors`** (per-item failures **never** escalate to job-level `failed`; spec FR-5.4).
- `failed` is **reserved for job-level precondition failures only**: empty provider chain (§4) or reference-normalization failure (§4) — i.e., the batch could not start and no Items ran. Therefore `job.done {status}` emits `failed` **only** in those precondition cases, never from Item aggregation — consistent with the spec's "a batch ends `completed` or `completed_with_errors`."

### 5.2 Worker pool (`pool.ts`)
Bounded-concurrency runner over the Item queue. `POOL_SIZE` (default 4–6, env — name aligned with the flow doc). Semaphore/promise-pool; a slot frees the moment an Item reaches terminal state, immediately pulling the next. One slow/failing Item never blocks siblings (FR-3.3).

### 5.3 Retry engine (`retry.ts`) — owns classification policy
Per-provider attempt loop. The **`kind`→decision mapping lives here** (PV emits only facts):

| `ProviderError.kind` | Decision |
|---|---|
| `rate_limit`, `server`, `timeout`, `unavailable` | **Retry** (within attempt cap; honors `retryAfterMs` on 429) |
| `auth`, `quota_exhausted` | **Fatal → advance provider immediately** |
| `content_policy`, `invalid_input` | **Fatal → item fails (no further provider helps)*** |

\* Content-policy/invalid-input is per-Item fatal with a clear message and does **not** fail the batch (spec §10/FR-5.5). Backoff: `delay = min(RETRY_MAX_MS, RETRY_BASE_MS * 2^attempt) + jitter`, full-jitter; `MAX_ATTEMPTS` default 3, env-configurable.

### 5.4 Per-provider rate limiter + quota pre-switch (`rateLimiter.ts`)
One **token bucket per providerId** keyed by RPM from quota config (e.g. ~10 RPM Gemini). `await take(providerId)` before each `generate`. Decouples `POOL_SIZE` from provider RPM so a large N doesn't cause 429 storms (spec risk §16). Also enforces the **quota pre-switch** (spec §6.4): as a provider nears its daily counter, the engine skips it in the chain for new Items.

> **MVP durability caveat (explicit).** The daily quota counter lives in the **in-memory store and resets on every cold start / scale-down**, so cross-invocation accumulation is **best-effort** in MVP — the pre-switch is a soft guard, and a genuinely exhausted provider is still caught at runtime by `quota_exhausted` → advance (§5.3). **Full product** moves the counter to **KV/Redis** for durable cross-instance accumulation (§8.2, §13).

### 5.5 Idempotency & result persistence (`idempotency.ts` + `blob.ts`)
- `attemptHash = hash(itemId + attemptNumber)`. Its sole role: guard against double-delivery within an attempt (a re-delivered identical attempt never produces a second stored object). The result key is **per-item** (`results/{jobId}/{itemId}.{ext}`, §5.5), not derived from `attemptHash`.
- **Result key (aligned with flow doc — per-item, attempt-independent):** `results/{jobId}/{itemId}.{ext}`, where `{ext}` is derived from the result content-type (`png|jpg|webp`). **Last-writer-wins:** every successful attempt (initial, retry, failover, or post-terminal targeted retry) overwrites the **same** object, so an item never yields more than one distinct result object and `item.result.imageUrl` is a stable URL. There are therefore **no orphan / non-winning result blobs**. "No duplicate results" holds: one item ⇒ exactly one result object that `item.result` references.
- **Result-persist step (resolves bytes-vs-URL gap).** After `provider.generate()` returns, the orchestration calls `blob.persistResult`: if `imageBytes` is raw bytes, store them under the per-item key (`{ext}` from content-type); if it is a **provider URL** (e.g. Replicate), **fetch it under the SSRF allowlist (§9)**, then store under the per-item key (`{ext}` from content-type). Only after the bytes are at the per-item Blob key does the orchestration set `item.result.imageUrl` and emit `item.result`. Adapters never persist; `item.result.imageUrl` therefore never points at an ephemeral provider URL (keeps idempotency + export stable).

### 5.6 Per-batch seed (`orchestrator` + entities)
`Job.seed: number` is **derived once at job creation** in `POST /api/jobs` (a stable numeric hash of `jobId`, so it is deterministic and reproducible) and persisted on the Job. Every Item's `GenerateInput.seed` is set from `Job.seed`; adapters pass it through to providers that support seeding (Gemini/Cloudflare where available), giving cross-post consistency (spec FR-6.2). It is **not** part of the request payload.

### 5.7 Crash / abort handling & sweeper (edge case → DoD)
The stream invocation registers an `AbortController`. On graceful function shutdown, stream close before `job.done`, or hitting `maxDuration`, the orchestrator **sweeps every non-terminal Item** (`queued`/`running`) to `failed` with code `interrupted` and emits `item.error` + a final `job.done`, so **every tile reaches a terminal state** (spec DoD, README §1/TZ §2). 

> **Hard-kill MVP gap (acknowledged).** If the instance is hard-killed with no graceful abort, the in-memory store + bus are lost and any in-flight Items are unrecoverable on that instance. This is the central MVP trade-off of in-memory + in-invocation orchestration; it is **eliminated in full product by the durable queue + Postgres** (§13). Client-side guard: if the stream closes without `job.done`, the FE marks still-non-terminal tiles as failed/interrupted with a Retry button.

### 5.8 Event bus (`eventBus.ts`)
In-process `EventEmitter`-style pub/sub, **per-Job**, plus a bounded **ring buffer** of the last K events with monotonic ids. Two consumers: the SSE writer (live subscribe + replay-since-id) and the state-store updater. Event ids are sequential per Job so `Last-Event-ID` reconnect replays precisely (§6). Co-located with the orchestrator in the stream invocation (no cross-request sharing on the happy path). Full-product swap: KV/Redis pub/sub for cross-instance delivery (§8, §13).

---

## 6. Streaming architecture

**Transport:** SSE via a streaming Route Handler (`ReadableStream`), per spec §8 — chosen over WebSocket because updates are one-way server→client and SSE gives native `Last-Event-ID` reconnect.

**Execution-model resolution (was a contradiction).** The orchestrator is **started and hosted by the stream handler**, not by `POST /api/jobs`. Because orchestration, the in-process event bus, and the SSE writer all live in the **same invocation**, the "an in-process `EventEmitter` cannot be shared across two requests" problem does not arise for the happy path — there is one request doing both. `POST /api/jobs` only persists Job+Items and returns `jobId`; the client renders optimistic placeholders and immediately opens the stream, which then drives generation.

### 6.1 SSE Route Handler (`app/api/jobs/[id]/stream/route.ts`)
```
GET /api/jobs/:id/stream
  headers: Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive
  1. load Job from store; if absent → 404
  2. parse Last-Event-ID header (if reconnect)
  3. if no orchestrator running for this job in THIS instance → start it (hosts pool+bus)
  4. subscribe eventBus(jobId)
  5. replay ring-buffer events with id > Last-Event-ID  (gap recovery)
  6. pipe live events as: "id: <n>\nevent: <name>\ndata: <json>\n\n"
  7. heartbeat ":\n\n" comment every ~15s (keep Fluid Compute conn warm, detect drop)
  8. on job.done -> flush, close stream
  9. on abort/shutdown -> orchestrator sweeps non-terminal items (§5.7)
  runtime = "nodejs"
```

### 6.2 Event schema (verbatim from spec §8.2; every frame carries an `id`)
```
id: <seq>  event: item.status   data: { itemId, status }
id: <seq>  event: item.result   data: { itemId, imageUrl, providerId, usedImageReference }
id: <seq>  event: item.error    data: { itemId, code, message, lastProviderId }
id: <seq>  event: job.progress  data: { done, failed, total }
id: <seq>  event: job.done      data: { status }
```

### 6.3 Reconnect & snapshot recovery
- **In-window drop, same warm instance:** the orchestrator is still running; browser `EventSource` auto-reconnects with `Last-Event-ID`; the handler replays buffered events with a greater id, then resumes live. No already-shown result is lost (FR-4.4).
- **Out-of-window / cold open, same instance:** client calls `GET /api/jobs/:id` for a full `Job` snapshot, hydrates the store, *then* opens the stream.
- **Merge rule (FE):** snapshot is the base; subsequent events are deltas keyed by `itemId` — idempotent application so a replayed event is harmless.
- **Different-instance reconnect (MVP limitation, explicit).** In MVP both replay (ring buffer) and snapshot (`GET /api/jobs/:id`) read **per-process** state. If a reconnect or direct-open lands on a **different** Fluid Compute instance (or after scale-down), the store/bus are empty and the snapshot returns **404**. The FE handles this explicitly (a "connection lost — state unavailable, retry" message, not a silent hang). With a single user and warm-instance reuse this is rare in practice but **real**; it is the #1 driver of the full-product move to **Postgres snapshot + KV/Redis pub/sub** (§8.2, §13), which makes reconnect instance-independent.

### 6.4 Vercel Fluid Compute note + duration budget
The long-lived SSE connection holds the function while the orchestrator runs Items concurrently *inside the same invocation* (spec §5.3). `maxDuration` is raised (e.g. **~300s**; Fluid Compute supports higher ceilings on appropriate plans) to cover N≤20 batches.

**Quantified budget (resolves the un-numbered claim):**
- *Happy path:* N=20, `POOL_SIZE`=5 ⇒ `ceil(20/5)=4` waves × ~15s/image ≈ **~60s** — comfortably within ~300s.
- *Pathological worst case:* one fully-degraded Item can cost up to `MAX_ATTEMPTS`(3) × (≤`RETRY_MAX_MS`=8s backoff + ~15s call) across up to 3 providers ≈ **~200s for a single Item**; a batch where many Items degrade this way **can exceed any single-function ceiling**. This is bounded — not by completing, but by the **`AbortController`/sweeper (§5.7)** terminalizing remaining Items as `failed(interrupted)` at `maxDuration`, so the DoD ("every tile reaches a terminal state") still holds. Eliminating the ceiling itself is the **durable-queue** full-product delta (§9.3, §13, spec risk §16).

---

## 7. Data model & API contracts

### 7.1 Entities (`lib/types.ts`, X1 — extends `TZ §7.1` with `seed` and `perImageHints`)
```ts
export type AspectRatio = "1:1" | "4:5" | "9:16";   // canonical home (re-exported by PV)

export type Job = {
  id: string;
  status: "running" | "completed" | "completed_with_errors" | "failed";
  // `failed` ⇒ JOB-LEVEL precondition failure ONLY (empty chain / reference
  // normalization failed — §5.1). Per-item failures never escalate past
  // `completed_with_errors`.
  seed: number;                         // per-batch deterministic seed, derived at create (§5.6)
  params: {
    aspectRatio: AspectRatio;
    brief?: string;
    perImageHints?: Record<string, string>; // keyed by productImageUrl → caption hint (§4 prompt)
  };
  referenceImageUrls: string[];
  items: Item[];
  createdAt: string;
};

export type Item = {
  id: string;
  jobId: string;
  productImageUrl: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: Attempt[];
  result?: { imageUrl: string; providerId: string; usedImageReference: boolean };
  error?: { code: string; message: string; lastProviderId: string };
};

export type Attempt = {
  providerId: string;
  startedAt: string;
  finishedAt?: string;
  outcome: "success" | "retryable_error" | "fatal_error";
  errorMessage?: string;
};
```

### 7.2 Endpoints (aligned with spec §7.2 and the flow doc; concrete request/response shapes)

| Method / path | Owner | Request | Response |
|---|---|---|---|
| `POST /api/uploads` | C7 | `{ filename: string; contentType: "image/png"\|"image/jpeg"\|"image/webp"; kind: "product"\|"reference" }` | `200 { uploadUrl: string; blobUrl: string }` · `400` invalid type. **Size is not a request field**: the minted signed token constrains content-type + **max size** at Blob, which rejects oversize uploads authoritatively (§8.1, §9). |
| `POST /api/jobs` | C8 | `{ productImageUrls: string[] (1..20); referenceImageUrls: string[] (1..2); params: { aspectRatio: AspectRatio; brief?: string; perImageHints?: Record<string,string> } }` | `201 { jobId: string }` · `400` validation · `429` rate-limited. Server SSRF-checks the URLs (§9), derives `seed`, persists Job+Items. |
| `GET /api/jobs/:id/stream` | C9 | — (SSE; optional `Last-Event-ID` header) | `200 text/event-stream` (§6.2) · `404` unknown job (incl. different-instance reconnect, §6.3) |
| `GET /api/jobs/:id` | C10 | — | `200 Job` snapshot · `404` |
| `POST /api/jobs/:id/items/:itemId/retry` | C11 | — | `200 { ok: true }` (**idempotent** — a `failed` item is re-driven; a non-`failed` item, incl. a lost CAS on a concurrent double-click, is a no-op) · `404` unknown job/item. No `409` — the only error is 404 (§5p) |

Validation lives in `lib/validation/*` as **isomorphic zod schemas** (no server-only imports), imported by **both** the routes (authoritative) **and** the FE (mirrored client-side, defense in depth, spec FR-1.3) — single source of truth, permitted across the L1↔L2 boundary by the amended §3 rule.

---

## 8. Storage architecture

### 8.1 Vercel Blob (`lib/blob/blob.ts`, BE)
- **Signed uploads:** `POST /api/uploads` mints a client-token / signed URL scoped to **content-type + max size**; the browser PUTs bytes directly to Blob (never through the function body — spec FR-1.5). The token's size constraint is the **authoritative server-side size enforcement** (Blob rejects oversize), even though the request body carries no client-declared size. Inputs land under `uploads/{kind}/{uuid}.{ext}`.
- **Resolution validation (reconciled with FR-1.3, honest).** Pixel dimensions are **not** available to `POST /api/uploads` (it sees only `{filename, contentType, kind}`, and bytes go client→Blob). MVP enforces resolution **client-side** (the uploader reads each image's natural dimensions and rejects out-of-bounds before requesting a token). An **optional post-upload verification step** at `POST /api/jobs` (read the Blob object's header/dimensions before the job starts, reject bad resolution) provides server-side enforcement when required; this is the documented path to fully satisfy FR-1.3 and is a candidate for full-product. Content-type + size remain authoritatively server-enforced via the signed token.
- **Per-item result keys (last-writer-wins):** result bytes are written by the orchestration under `results/{jobId}/{itemId}.{ext}` (§5.5), `{ext}` from content-type — every successful attempt overwrites the same object; `item.result.imageUrl` is a stable per-item URL with no orphan / non-winning result blobs.
- Full-product adds lifecycle/cleanup (TTL on `uploads/`, retained `results/`).

### 8.2 State store (`lib/state/store.ts`, BE)
A `StateStore` interface (incl. an **atomic status CAS** used by the retry route, §5/§11) with two implementations behind it:

| Concern | MVP — `memoryStore.ts` | Full — `pgStore.ts` (+ KV) |
|---|---|---|
| Job / Item / Attempt | In-memory `Map`, per-process | Postgres (Neon): `jobs`, `items`, `attempts` tables |
| Ephemeral progress / pub-sub | In-process event bus (§5.8) | KV/Redis (Upstash) pub-sub for distributed workers |
| **Daily quota counter** | In-memory, **resets on cold start** (best-effort, §5.4) | KV/Redis durable counter (cross-instance) |
| Snapshot survives different-instance reconnect | **No** (per-process — §6.3 limitation) | Yes (Postgres) |
| History / permalinks | — (not in MVP) | Queried from Postgres |
| Survives restart | No (accepted MVP trade-off) | Yes |

The store interface is identical across impls so the orchestrator is storage-agnostic. MVP single-process matches the single-user, single-invocation Fluid Compute model; its cross-instance gaps (§5.7, §6.3, §5.4) are the explicit drivers of the full-product deltas (§13).

---

## 9. Security architecture

- **Server-only provider keys.** `GEMINI_API_KEY`, `CLOUDFLARE_*`, `REPLICATE_API_TOKEN`, `BLOB_READ_WRITE_TOKEN` are read only inside Route Handlers / adapters; never serialized to client, never in `NEXT_PUBLIC_*`. All provider HTTPS originates in `lib/providers/**` (spec §10).
- **SSRF surface (explicit, with a clean seam).** The server performs `fetch` against two URL classes:
  - **User-supplied URLs** in `POST /api/jobs` (`productImageUrls`, `referenceImageUrls`): validated **at the route/validation layer (BE)** before they ever reach any adapter — accept only URLs on the app's own Vercel Blob origin/host allowlist (they must have come from `/api/uploads`), scheme=`https`, block private/link-local/metadata ranges (169.254/10/172.16/192.168/127), cap response size + content-type, set timeouts/`AbortSignal`.
  - **Provider-returned result URLs** (e.g. Replicate): fetched by the **BE result-persist step (§5.5)**, restricted to each provider's known host(s), same size/type/timeout caps.
  - **Adapters** only fetch the **already-validated, trusted app-origin Blob input URLs** carried in `GenerateInput` (to inline bytes for the provider request). They never fetch user-supplied-but-unvalidated URLs and never touch provider result URLs — so adapters need **no** SSRF util and **no** `blob.ts` import, keeping the PV seam clean.
- **Upload validation.** Content-type ∈ {png,jpg,webp} and size ≤ 10 MB are enforced **authoritatively by the signed token** at Blob (rejects on violation); resolution is enforced client-side in MVP with an optional server post-upload check (§8.1). Honest reconciliation of FR-1.3/spec §10.
- **Rate-limiting `POST /api/jobs`.** Basic per-IP token bucket (`lib/security/rateLimit.ts`) to prevent abuse (spec §10). 429 on exceed.
- **Content policy.** Provider moderation rejects are fatal-per-item with a human-readable message; never fail the batch (spec §10/FR-5.5).
- **No auth.** Single-user; no login, no multi-user isolation (spec §16 decision). Recorded as deliberate scope.

---

## 10. Observability architecture

- **Per-item-attempt structured logs** (`lib/observability/logger.ts`), one line per attempt: `jobId, itemId, attempt, providerId, outcome, latencyMs, errorCode` (spec §12). JSON to stdout → Vercel logs sink.
- **Metrics** (`lib/observability/metrics.ts`): per-provider **success rate**, **failover share** (fraction of Items not served by primary), **p50/p95 generation latency**, **prompt-only degradation share** (fraction with `usedImageReference:false`), and **quota-pre-switch count** (how often the daily-quota guard skipped a provider, §5.4).
- **Per-batch summary** emitted on `job.done`: counts success/failed, provider distribution, total wall time, degradation count, and whether the batch was `interrupted` by the sweeper (§5.7).
- **Sink:** Vercel logs (MVP). **OTel hook:** a thin `otel.ts` shim (no-op in MVP, wired in full-product) exporting spans per Item-attempt and counters per provider. Full-product adds dashboards + alerts on provider degradation (spec §15).

---

## 11. Deployment architecture

- **Platform:** Vercel, Git import. **Preview deploy per push**, **production on `main`** (spec §14). Zero manual infra (NFR-8).
- **Runtime:** Route Handlers on the **Node.js runtime** (Blob SDK, provider SDKs, streaming), **Fluid Compute enabled** for the long-lived SSE stream that hosts orchestration; function `maxDuration` raised to ~300s to cover N≤20 batches (§6.4).
- **Build:** pnpm. Lint/format gate **Biome**; tests **Vitest** in CI (full-product) / pre-push (MVP).
- **Env var inventory** (spec §14):

```
GEMINI_API_KEY            # primary provider           (MVP)
CLOUDFLARE_ACCOUNT_ID     # secondary provider         (MVP)
CLOUDFLARE_API_TOKEN      # secondary provider         (MVP)
REPLICATE_API_TOKEN       # optional tertiary provider (opt.)
BLOB_READ_WRITE_TOKEN     # Vercel Blob                (MVP)
DATABASE_URL              # Postgres/Neon              (full-product)
KV_URL                    # KV/Upstash: pub-sub + durable quota counter (full-product)
# tunables (env, not hardcoded):
POOL_SIZE=5  MAX_ATTEMPTS=3  RETRY_BASE_MS=500  RETRY_MAX_MS=8000
PROVIDER_CHAIN=gemini,cloudflare[,replicate]  MAX_PRODUCT_IMAGES=20
GEMINI_RPM=10  GEMINI_DAILY=500  CLOUDFLARE_DAILY_NEURONS=10000
MAX_FUNCTION_DURATION_S=300
```

---

## 12. Concrete directory / file structure

Every path carries its owner. The layout physically enforces the §2 boundary: **failover engine under `lib/orchestrator/`, adapters under `lib/providers/`, composition wiring in `orchestrator.ts`.**

```
batch-creative-studio/
├─ app/
│  ├─ layout.tsx                         FE  C1 shell, fonts, visual language
│  ├─ page.tsx                           FE  C1 main (server shell + client islands)
│  ├─ globals.css                        FE  C1 white/charcoal, ALL-CAPS labels, responsive grid
│  └─ api/
│     ├─ uploads/route.ts                BE  C7  signed-upload mint (type+size token)
│     ├─ jobs/route.ts                   BE  C8  create job (no gen): seed, SSRF, persist
│     └─ jobs/
│        └─ [id]/
│           ├─ route.ts                  BE  C10 job snapshot (reconnect)
│           ├─ stream/route.ts           BE  C9  SSE + HOSTS orchestrator (Fluid Compute)
│           └─ items/[itemId]/retry/route.ts  BE  C11 CAS failed→queued, re-drive item
│
├─ components/                           FE  (all client UI; responsive — §2.1)
│  ├─ uploader/{Uploader,DropZone,FilePreview}.tsx      C2 (client type/size/resolution checks)
│  ├─ params/ParamsForm.tsx                              C3 (builds perImageHints)
│  ├─ grid/{BatchGrid,Tile,StatusBadge,PromptOnlyBadge}.tsx  C4 (responsive reflow)
│  └─ export/{DownloadOne,DownloadZip}.tsx               C6
│
├─ lib/
│  ├─ types.ts                           BE→shared  X1 Job/Item/Attempt/AspectRatio(canonical)/events
│  ├─ validation/{uploads,jobs}.ts       shared  isomorphic zod schemas (FE + routes)
│  ├─ client/                            FE
│  │  ├─ store.ts                         C5  Zustand batch store
│  │  ├─ sseClient.ts                     C5  EventSource + reconnect + merge + 404 handling
│  │  ├─ uploadClient.ts                  C2  signed PUT to Blob
│  │  └─ zip.ts                           C6  batch zip
│  ├─ orchestrator/                      BE  (L3)
│  │  ├─ orchestrator.ts                  C12 composition root: builds inputs, injects chain, sweeper
│  │  ├─ pool.ts                          C13 POOL_SIZE concurrency cap
│  │  ├─ retry.ts                         C14 backoff+jitter + OWNS kind→decision policy
│  │  ├─ failover.ts                      C15 ENGINE — imports ImageProvider + ProviderError facts ONLY
│  │  ├─ rateLimiter.ts                   C16 per-provider token bucket + quota pre-switch
│  │  ├─ idempotency.ts                   C17 attemptHash = hash(itemId+attempt), per-item result key
│  │  └─ eventBus.ts                      C18 pub/sub + replay ring buffer
│  ├─ providers/                         PV  (L4 — ADAPTERS live here)
│  │  ├─ types.ts                         C21 ImageProvider + DTOs; re-exports AspectRatio
│  │  ├─ errors.ts                        PV  ProviderError taxonomy — NEUTRAL facts only
│  │  ├─ registry.ts                      C25 ordered chain + quota lookup + chain validation
│  │  ├─ config.ts                        C25 env: chain, models, quotas, RPM
│  │  ├─ gemini.ts                        C22 Nano Banana adapter
│  │  ├─ cloudflare.ts                    C23 Workers AI adapter
│  │  ├─ replicate.ts                     C24 optional adapter (URL result → BE re-persist)
│  │  ├─ referenceNormalizer.ts           C26 one-time reference preprocess (+ failure path)
│  │  └─ prompt.ts                        C27 shared template + resolved per-image hint + style text
│  ├─ blob/blob.ts                       BE  C19 sign uploads; fetch-url + PNG-normalize + persist results
│  ├─ state/                             BE
│  │  ├─ store.ts                         C20 StateStore interface (+ atomic status CAS)
│  │  ├─ memoryStore.ts                   C20 MVP in-memory impl
│  │  └─ pgStore.ts                       BE  full-product impl (stub in MVP)
│  ├─ security/rateLimit.ts              BE  per-IP limit for POST /api/jobs
│  └─ observability/{logger,metrics,otel}.ts  BE  X2
│
├─ test/                                 TS
│  ├─ fakes/fakeProvider.ts               C28 controllable failures
│  ├─ unit/{retry,failover,rateLimiter,idempotency}.test.ts   C29
│  ├─ unit/boundaries.test.ts             C29 architecture/seam test (see note)
│  ├─ unit/providers/{gemini,cloudflare}.mapper.test.ts       C29 (mocked HTTP)
│  ├─ integration/jobs-stream.test.ts     C29 POST create → open stream → events → terminal
│  ├─ e2e/forced-failover.manual.md       C29 MANUAL E2E: real Gemini batch + forced primary
│  │                                          fail → verify Cloudflare failover + prompt-only badge
│  └─ fixtures/*                          C29
│
├─ biome.json                            TS  lint/format
├─ vitest.config.ts                      TS
├─ package.json                          (pnpm)
└─ vercel.json                           BE  fluid/runtime config (maxDuration)
```

> **Boundary-enforcement note (TS-owned):** `test/unit/boundaries.test.ts` (or a Biome/`dependency-cruiser` rule) asserts that `lib/orchestrator/**` never imports `lib/providers/{gemini,cloudflare,replicate}.ts`; that `lib/orchestrator/failover.ts` imports neither the registry/config nor prompt/referenceNormalizer; that `lib/providers/**` never imports `lib/orchestrator/**`, `lib/state/**`, or `lib/blob/**`; and that `app/api/**` never imports a concrete adapter. The seam is tested, not just documented.
>
> **Manual acceptance (spec §13):** `forced-failover.manual.md` documents the required hands-on E2E — run a real Gemini batch, force a primary failure (revoke key / inject 5xx), and verify the chain advances to Cloudflare and the prompt-only badge appears.

---

## 13. MVP vs full-product architectural deltas

| Dimension | MVP (this build) | Full product (target vision) |
|---|---|---|
| Orchestration runtime | In-flight **inside the SSE stream handler** (Fluid Compute) | **Durable queue** (Vercel Queues / external worker) — survives restarts/timeouts |
| State store | In-memory per-process (`memoryStore.ts`) | **Postgres/Neon** (`pgStore.ts`): jobs/items/attempts |
| Pub/sub for SSE | In-process event bus + ring buffer | **KV/Redis (Upstash)** pub-sub; SSE route = thin subscriber |
| Daily quota counter | In-memory, resets on cold start (best-effort, §5.4) | **KV/Redis** durable cross-instance counter |
| Reconnect / snapshot across instances | Per-process; different-instance → 404 (§6.3) | Instance-independent via Postgres snapshot + KV pub-sub |
| Crash / scale-down mid-batch | Sweeper terminalizes on graceful abort; hard-kill loses state (§5.7) | Eliminated by durable queue |
| Providers | Gemini → Cloudflare (Replicate optional) | + **Replicate IP-Adapter** for better fallback style consistency |
| Persistence / history | None (results in Blob only) | Batch history, **permalinks**, Blob lifecycle/cleanup |
| Resolution validation | Client-side + optional post-upload check (§8.1) | Server post-upload dimension check standard |
| Observability | Vercel logs + in-memory metrics | External sink, dashboards, **alerts** on provider degradation; OTel wired |
| Workers | Single-process pool | KV/Redis-coordinated distributed workers |
| Auth | None (single-user) | Optional multi-user isolation (still out of core scope) |
| Tests / CI | Reliability-core unit + boundary + 1 integration + manual E2E | Full suite + CI gates |
| Resilience to function timeout | Mitigated by streaming + Fluid Compute + sweeper | Eliminated by durable queue |

---

## 14. Key technology decisions

| Decision | Rationale (one line) |
|---|---|
| **Orchestration runs INSIDE the SSE stream handler** (spec §5.3 baseline), POST only creates the job | Co-locates orchestrator + in-process event bus + SSE writer in one invocation, so the bus is reachable without cross-request sharing; single-user warm-instance reuse makes it work for MVP; durable queue deferred to full-product. |
| **SSE** (not WebSocket) | One-way server→client updates only; native `Last-Event-ID` reconnect; far simpler to run on Vercel Functions. |
| **In-memory + in-flight orchestration** for MVP (not a queue) | Single-user, N≤20 fits one Fluid Compute invocation; cross-instance gaps (§5.7/§6.3) are an accepted, documented trade-off, removed by the durable queue in full-product. |
| **Per-item result key `results/{jobId}/{itemId}.{ext}` (last-writer-wins)** | Aligns with the flow doc; one stable per-item object overwritten by every successful attempt makes idempotency and export deterministic (no orphan / non-winning result blobs). |
| **Gemini 2.5 Flash Image ("Nano Banana") primary** | Best native image-reference style conditioning, generous no-card free tier (~500/day, ~10 RPM). |
| **Cloudflare Workers AI fallback** | Free via REST (10k neurons/day), edge-friendly; klein gives edit, schnell/SDXL give prompt-only degradation path. |
| **Replicate tertiary, optional** | Pay-per-use; only worth enabling with budget; IP-Adapter improves fallback consistency in full-product. |
| **fal.ai excluded** | Free credits work only in Sandbox/Playground, **not via API** — useless in a production failover chain. |
| **OpenAI `gpt-image-1` excluded** | No working free tier under the challenge constraints. |
| **`ImageProvider` interface as the failover seam; composition root builds inputs** | Failover engine depends only on the contract + neutral error facts; the orchestrator (composition root) wires registry/prompt/normalizer; adapters are swappable and unit-testable in isolation. |
| **Error taxonomy as neutral facts in PV; policy in retry.ts (BE)** | Keeps provider→fact and engine→decision cleanly separated; no BE policy leaks into the providers package. |
| **Vercel Blob signed uploads (type+size in token)** | Bytes go client→Blob directly; size enforced authoritatively by the token without a trusted client-declared number; generation passes URLs not base64. |
| **Fluid Compute + `maxDuration` + abort sweeper** | Keeps the SSE connection alive while Items process concurrently; the sweeper guarantees every tile terminalizes even in the pathological worst case (§6.4). |
| **Biome** | Single fast lint+format toolchain, zero-config, no ESLint/Prettier split. |
| **Vitest** | Fast TS-native unit/integration runner; pairs with the fake provider for deterministic reliability tests and the boundary test. |
| **pnpm** | Fast, disk-efficient, strict dependency resolution. |
| **Zustand for client batch state** | Minimal store updated per-`itemId` from SSE; tiles subscribe independently for progressive, responsive rendering. |