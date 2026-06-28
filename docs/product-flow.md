# Product Flow & Step-by-Step Behavior

> Engineering companion to `README.md`, `docs/TZ.md`, and the **Architecture** doc for **Batch Creative Studio**. This document does not restate the *what*; it pins down the exact *how* — every step, every transition, every edge path — so that frontend, backend, providers, and testing implementers share one unambiguous behavioral contract. Where the README/TZ/Architecture define a contract (endpoints, event names, state names, entity fields, env), this doc treats it as **authoritative** and only extends it. Anything labeled **(decision)** is a behavioral choice this doc fixes that the specs left implicit; none of them contradict the specs. Where the draft previously diverged from the Architecture doc (result-blob key, concurrency config name, retry response, upload body, per-image hints), this revision aligns to the Architecture doc.

---

## 0. Vocabulary & invariants (read first)

- **Job** = one Generate run. Holds `params { aspectRatio; brief?; perImageHints? }`, `referenceImageUrls`, and N **Items**. Status ∈ `running | completed | completed_with_errors | failed`.
  - **(decision) Job-status semantics.** Item **aggregation** only ever yields `completed` or `completed_with_errors`. The all-items-failed case is `completed_with_errors` with `done=0, failed=N` — **not** job `failed`. The `failed` status is **reserved for a whole-job failure that is not item aggregation**: the job could not run at all (internal orchestrator/init error, or batch-level reference normalization failing before any item was attempted). This keeps the FR contract — "the batch as a whole never crashes because of individual items" (README §3 / TZ FR-5.4 / §9.5) — literally true while still giving the spec's `failed` status (TZ §7.1) a defined trigger.
- **Item** = one product image → one post. Status ∈ `queued | running | succeeded | failed`. Owns an ordered list of **Attempts**.
- **Attempt** = one call to one provider for one item. Outcome ∈ `success | retryable_error | fatal_error`. Carries `providerId`, `startedAt`, `finishedAt?`, `errorMessage?`.
- **Provider** = an `ImageProvider` adapter (`lib/providers/**`). The **failover engine** (backend) consumes the interface only.
- **Single-writer invariant.** Item/Job mutations are performed **only** by the backend orchestrator. The backend is also the **sole writer of result bytes** to Blob; provider adapters only *return* `imageBytes | url` and never touch Blob. The client store is a read-model rebuilt from SSE + snapshot; it never authors authoritative state, only optimistic placeholders that are reconciled by server events.
- **Attempt cap.** `ATTEMPT_CAP` total attempts **per provider** (default `3`, env-config). Attempts are numbered `0..ATTEMPT_CAP-1` for a given provider; reaching the cap without success triggers failover. **(decision)** The spec's failover diagram wording "Gemini (3 retries)" (README §5.2 / TZ §6.2) is read in this doc as **3 attempts total** per provider (1 initial + 2 retries), i.e. `attemptNumber ∈ {0,1,2}` — **not** 1 initial + 3 retries. This off-by-one is fixed here explicitly so every diagram and count in this doc agrees.
- **Per-attempt timeout.** Each provider call runs under `ATTEMPT_TIMEOUT_MS` (default `60000`, env-config) plus an `AbortSignal`; a timeout is a **retryable** error. The Terminal invariant depends on this bound.
- **Terminal invariant (within a single function lifetime).** *Provided the orchestrator process survives*, every item reaches `succeeded` or `failed` and every job reaches a terminal status — no item or job hangs (per-attempt timeouts + attempt caps + failover exhaustion guarantee forward progress). This holds **only within one function lifetime**: in the MVP (in-memory state + in-flight orchestration inside the streaming handler), a function/process recycle abandons the batch (see §11). The deferred durable queue is what makes the invariant unconditional.
- **Idempotency invariant.** Two distinct keys cooperate:
  - **(a) Provider-call de-dup:** `idempotencyKey = hash(itemId + attemptNumber)` is passed into each provider call so a redelivered request for the same attempt is de-duplicated provider-side.
  - **(b) Result storage:** the result image is written to Blob under a **per-item, attempt-independent** key `results/{jobId}/{itemId}.{ext}` — **last writer wins** (aligned to Architecture §5.5/§8.1). Because every successful attempt (initial, retry, failover, or post-terminal targeted retry) overwrites the **same** object, an item can never produce more than one distinct result object, and `result.imageUrl` always points at that one stable key. `{ext}` is derived from the result's content-type (`png|jpg|webp`). A consequence: there are **no orphan/non-winning result blobs** to reclaim (the leak that remains is on *uploads* — see §5t).
- **Job-creation idempotency.** **(decision)** The client attaches an `Idempotency-Key` (UUID per Generate click) to `POST /api/jobs`; a duplicate key within a short window returns the **same** `{ jobId }`, so a double-click cannot mint two jobs (§5o).
- **Per-image caption hint placement.** `POST /api/jobs` accepts `params.perImageHints?: Record<string,string>` (matching Architecture), keyed by **productImageUrl**. **(decision)** `Job.params.perImageHints?: Record<string,string>` keyed by `productImageUrl`; resolved at the composition root when building each Item's `GenerateInput` (`params.perImageHints?.[item.productImageUrl]`), passed to the prompt builder; no new persisted Item field. The **Job entity** keeps `params: { aspectRatio; brief?; perImageHints? }` (Architecture §7.1).
- **Config is env-driven.** Concurrency, attempt cap, per-attempt timeout, backoff params, provider chain order, and per-provider RPM/quota thresholds are config (see §10). Quotas/limits change **without redeploy** (TZ §6.4).
- **N / R bounds.** `1 ≤ N ≤ 20` product images (configurable, `MAX_ITEMS`). References: `1 ≤ R ≤ 2`.

---

## 1. Actors & surfaces

| Actor / surface | Owner agent | Role | Trust boundary |
|---|---|---|---|
| **The user** (single, no auth) | — | Uploads images, sets params, clicks Generate, watches tiles, retries failures, exports. | Untrusted client. |
| **Client app** (Next.js Client Components) | frontend | Uploader, params form, **responsive** batch grid of progressive tiles (NFR-7: reflows desktop→mobile), SSE client + reconnect, client store (read-model), export (single + zip). | Browser; holds **no** secrets. |
| **Server route handlers** (Vercel Functions, server-only) | backend | `/api/uploads`, `/api/jobs` (**per-IP rate-limited**, README §8 / TZ §10), `/api/jobs/:id`, `/api/jobs/:id/stream`, `/api/jobs/:id/items/:itemId/retry` → `200 { ok: true }`. Hosts orchestrator, worker pool, retry engine, per-provider rate limiter (consumes RPM/quota numbers **from providers config**), failover **engine**, event bus, SSE server, in-memory state store, blob signing, **sole writer of result bytes**, structured logging + metrics. | Server; holds all secrets. Sole writer of Job/Item state. |
| **Provider adapters** (`lib/providers/**`) | providers | `ImageProvider` implementations: Gemini (primary), Cloudflare (secondary), Replicate (optional tertiary). Also providers-owned **modules invoked by the backend**: reference normalization, prompt-template + style-text builder, model/quota/RPM/seed-support config. Each adapter honors `aspectRatio` (post-processing if its model can't natively). | Server-side; each wraps one external API. |
| **Fake provider** (`lib/testing/**`) | **testing** | Controllable `ImageProvider` (timeout/429/fatal/empty-200) for deterministic reliability tests. Implements the providers-owned interface but **lives under the testing boundary** (not shipped in the failover chain). | Test-only. |
| **Provider APIs** (external) | external | Gemini 2.5 Flash Image, Cloudflare Workers AI (FLUX.2 klein / FLUX.1 schnell / SDXL), Replicate (FLUX + Redux/IP-Adapter). | Third-party; rate-limited, quota-limited, may reject content. |
| **Blob storage** (Vercel Blob) | backend (**signs uploads + sole writer of result bytes**) / providers (**return bytes/url only**) | Stores uploaded product + reference images and generated result images. Signed direct client→Blob upload; generation consumes **URLs**, not base64. Public-read result URLs with **CORS allowing the app origin** (for client-side single + zip download). | Server-signed; public-read result URLs. |
| **State store** | backend | In-memory (MVP): Jobs, Items, Attempts, event log/cursor, per-provider quota + token-bucket counters (**process-global**, shared across any concurrent jobs — §5s). (Full: Postgres + KV.) | Server process memory. |
| **Observability sink** | backend | Structured per-item-attempt logs + metrics + per-batch summary to Vercel logs (Full: external sink). | Server. |

```
            ┌──────────── browser (untrusted) ────────────┐
   user ──▶ │ Uploader │ Params │ Batch grid │ SSE client  │
            └──┬───────────┬────────────────────┬──────────┘
   signed PUT  │  POST /api/uploads {…}          │ GET /api/jobs/:id/stream (SSE)
   to Blob ◀───┘  POST /api/jobs (per-IP RL)     │ GET /api/jobs/:id (snapshot)
            ┌──────────── server (trusted) ──────┴──────────┐
            │ route handlers · orchestrator · worker pool ·  │
            │ retry engine · per-provider rate limiter ·     │
            │ FAILOVER ENGINE (consumes ImageProvider) ·     │
            │ event bus · SSE server · in-memory state ·     │
            │ SOLE WRITER of result bytes · logs/metrics     │
            └──┬───────────────────────┬────────────────────┘
   invokes:    │ adapters              │ signed read/write
   normalize / │                       │
   promptbuild │                       │
   styletext   │                       │
            ┌───▼─────────┐      ┌──────▼──────────┐
            │ Gemini /    │      │ Vercel Blob     │
            │ Cloudflare /│      │ uploads + results│
            │ Replicate*  │      │ (CORS: app origin)│
            └─────────────┘      └─────────────────┘
```

**Ownership clarifications (boundary fixes).**
- Reference **normalization**, the **prompt-template builder**, and the **style-text extractor** are **providers-owned modules**; the backend orchestrator **invokes** them (once per job for normalization/style-text; once per attempt for prompt assembly) but never authors prompt strings or normalization logic itself.
- The **batch-deterministic seed** is computed by the **orchestrator** and passed as `GenerateInput.seed`; providers merely **honor** it where their model supports seeds (seed-support is providers config).
- The **normalized reference handoff**: the providers-owned normalization step produces normalized reference **Blob URLs**, cached on the job. The backend substitutes those normalized URLs into `GenerateInput.referenceImageUrls` (still `string[]`, Architecture §5.4) for every attempt. The backend owns the substitution; the adapter only sees URLs.
- Per-provider **RPM/quota numbers** are **providers config**; the backend rate limiter and quota counters **consume** them (no backend hardcoding).

---

## 2. End-to-end HAPPY PATH (granular walkthrough)

Scenario: N=10 product images, R=1 reference, format `1:1`, a short brief. Everything succeeds on Gemini.

For each step: **[U]** what the user sees · **[C]** what the client does · **[S]** what the server does · **[→]** data that moves.

### Phase A — Load & compose

1. **Page load.**
   - [U] Editorial single-column shell: title, `UPLOAD` section (empty drop zones for product + reference), params, a disabled `GENERATE` button.
   - [C] Server Component renders static shell; Client Components hydrate (uploader, params form, empty grid, store initialized empty). No network beyond the document.
   - [S] Serves the static route. No job state yet.

2. **User adds product images (drag&drop or picker).**
   - [U] Each accepted file appears as a thumbnail with filename + remove (×). Count badge `n / 20`.
   - [C] **Client validation** per file (FR-1.3): MIME ∈ {png,jpg,webp}, size ≤ 10 MB, decodes as image, within resolution bounds, and running count ≤ `MAX_ITEMS` (20). Rejected files are **not** added; an inline error names the file + reason (§5h). Valid files held as local `File` objects (with their byte `size`) pending upload.
   - [S] Nothing yet.

3. **User adds 1–2 reference images.**
   - [U] Reference thumbnails appear in a visually distinct `REFERENCE` slot (tagged separately from product). Picker disables once 2 are present.
   - [C] Same per-file validation; enforces `R ∈ {1,2}`.

4. **Upload-on-add (signed direct upload).** *(decision: upload eagerly as files are added, not at Generate, so Generate only sends URLs.)* For each validated file:
   - [C] `POST /api/uploads` with `{ filename, contentType, kind: "product" | "reference" }`.
   - [S] Validates `contentType` against the allowlist and `kind`; mints a **signed upload token/URL** that constrains content-type + **max size** at Blob (authoritative oversize rejection — no client-declared size); returns `{ uploadUrl, blobUrl }`. No bytes pass through the function.
   - [C] PUTs the file bytes **directly to Blob** via `uploadUrl`. On success, stores the returned `blobUrl` against that thumbnail; the thumbnail shows an "uploaded" tick. On failure, marks the thumbnail errored with a per-file retry.
   - [→] file bytes: browser → Blob. Metadata (`filename, contentType, kind`): browser ↔ server. `blobUrl`: server → browser.

5. **User sets params.**
   - [U] Format selector (`1:1` default, `4:5`, `9:16`), optional batch **brief** textarea, optional per-image **caption hint** on each product thumbnail.
   - [C] Held in the params slice of the store. Per-image hints are collected into a `perImageHints` map keyed by the product's `blobUrl`. No server call.

6. **Generate becomes enabled.**
   - [C] Enabled iff: ≥1 product uploaded (has `blobUrl`), 1–2 references uploaded, every selected file finished uploading, count ≤ 20.

### Phase B — Launch

7. **User clicks GENERATE.**
   - [U] Button shows a busy state; the page scrolls to a freshly rendered **responsive grid of N placeholder tiles** (NFR-7: multi-column on desktop, reflowing to fewer/one column on narrow viewports), each labeled `QUEUED`. Global indicator reads `0 of 10 done · 0 errors`.
   - [C] `POST /api/jobs` with `{ productImageUrls[], referenceImageUrls[], params: { aspectRatio, brief?, perImageHints?: Record<string,string> } }` plus an `Idempotency-Key` header (UUID for this click). Immediately renders **optimistic placeholders** (one per product URL, in submitted order) so the grid never waits on the response. *(decision: tiles key on submitted array index until server item IDs arrive; the snapshot/first events reconcile index→itemId.)*
   - [C] **Failure handling (decision, §5j):** if `POST /api/jobs` returns 4xx/5xx or the network drops, the client **rolls back** the optimistic placeholders (removes the grid), restores the form to its editable pre-launch state, clears the busy button, and shows an inline error. No `jobId` ⇒ no orphaned tiles.
   - [S] Enforces **per-IP rate limit** (README §8 / TZ §10), then validates payload (URL shape, counts, params enum). On the same `Idempotency-Key` within the window, returns the existing `{ jobId }` (§5o). Otherwise creates a **Job** (`status=running`) with N **Items** (`status=queued`, empty `attempts`), keeping `perImageHints` on `Job.params` (resolved per item at generation time, not copied onto Items). Invokes the **providers-owned reference normalization once** (each reference fetched/resized/encoded → normalized reference Blob URLs, cached on the job) and the **providers-owned style-text extraction once** (a text description of the reference style, cached on the job for prompt-only fallback — §5c). Returns `{ jobId }`. Enqueues all N items and starts draining (§6).
   - [→] product/reference `blobUrl[]` + params: browser → server. `jobId`: server → browser.

8. **Client opens the stream.**
   - [C] On receiving `jobId`, replaces optimistic tile keys with real `itemId`s (from the job snapshot or first `item.status` events) and opens `GET /api/jobs/:id/stream` (EventSource). Sets `Last-Event-ID` handling for later reconnects. *(If the very first connect fails — distinct from a mid-stream drop — see §5q.)*
   - [S] Stream handler attaches the connection to the job's **event bus**. It first **replays** any events already emitted since job start (so a stream opened a beat late loses nothing), then forwards live events. Sends an initial `job.progress { done:0, failed:0, total:10 }`. *(decision: every emitted SSE event carries a monotonic integer `id:` = the job's event sequence number, enabling `Last-Event-ID` replay.)*

### Phase C — Drain & progressive render

9. **Worker pool drains the queue (§6).**
   - [S] Up to `POOL_SIZE` (env, default `5`; spec range 4–6) items are `running` concurrently. Each item, before its provider call, must acquire a token from the **current provider's token bucket** (Gemini's RPM, sourced from providers config — ~10 RPM). Items beyond the pool limit or the rate budget stay `queued`. The pool + buckets are **process-global** (§5s).

10. **Per-tile lifecycle — one item.**
    - [S] Worker picks item `i`, sets `status=running`, appends an Attempt `{ providerId:"gemini", startedAt }`, emits `item.status { itemId, status:"running" }`. Builds `GenerateInput` via the **providers-owned prompt builder** (`prompt = promptBuilder(template, brief, params.perImageHints?.[item.productImageUrl], styleText)`), with `referenceImageUrls` = the cached **normalized** reference URLs, `aspectRatio`, and `seed` = the orchestrator's batch-deterministic value. Calls `gemini.generate(input, signal)` with `idempotencyKey = hash(itemId+0)` under `ATTEMPT_TIMEOUT_MS` + AbortSignal.
    - [U] Tile flips `QUEUED → GENERATING` (a muted, shimmer-free indicator; editorial restraint).
    - [S] On provider return: **validates** the result is a non-empty, decodable image (guards an HTTP-200 empty/corrupt/zero-byte body — §5k); an invalid body is classified `retryable_error`. On a valid result: backend (**sole writer**) writes the bytes to Blob at the **per-item key** `results/{jobId}/{itemId}.{ext}` (`{ext}` from result content-type, **last writer wins**), gets the public `imageUrl`. Sets Attempt `outcome=success, finishedAt`; sets item `status=succeeded`, `result={ imageUrl, providerId:"gemini", usedImageReference:true }`. Accounts provider quota. **Logs** one structured attempt line (incl. `meta.latencyMs`, `meta.model`). Emits `item.result { itemId, imageUrl, providerId, usedImageReference:true }` then `job.progress { done++, failed, total }`.
    - [C] On `item.result`: that tile renders the final image immediately (the image is the hero — no card chrome). Tile label clears to a small meta line (`GEMINI`). Global indicator increments. **Only the one tile re-renders** (each tile subscribes to its own `itemId`).
    - [→] input URLs: server → provider. result bytes: provider → server → Blob. `imageUrl`: server → browser.

11. **Steps 9–10 repeat** for all items, bounded by pool + rate limiter. Tiles finish **out of order** — whichever provider call returns first renders first. Time-to-first-result is governed by the fastest of the first ≤`POOL_SIZE` calls (target ≤ ~15 s, NFR-1).

### Phase D — Completion & export

12. **All items terminal.**
    - [S] When every item is `succeeded|failed`, the orchestrator computes job status by aggregation (§4). Here all succeeded → `completed`. Emits final `job.progress { done:10, failed:0, total:10 }` then `job.done { status:"completed" }`. **Emits the per-batch summary log** (§9). Then closes the stream.
    - [U] Global indicator reads `10 of 10 done · 0 errors`; a `DOWNLOAD ALL (ZIP)` action becomes prominent.
    - [C] On `job.done`, closes EventSource cleanly (**no auto-reconnect**). **(decision, §3/§5d):** the client **retains the ability to reopen** the stream — a later targeted Retry on this terminal job reopens `GET /api/jobs/:id/stream` (with `Last-Event-ID` or fresh) so it receives the new `item.status`/`item.result`/`item.error` and the **re-emitted** `job.done`. A client that closed but never reopens would otherwise miss the second `job.done`.

13. **Export — single post.**
    - [U] Hovering/selecting a finished tile reveals a download affordance.
    - [C] Triggers download of that tile's full-resolution `imageUrl` directly from Blob. **(decision, §5m):** since the Blob URL is cross-origin, this relies on the result bucket's **CORS allowing the app origin**; the client uses an `<a download>` to the public URL, falling back to `fetch → blob → saveAs` when the `download` attribute is ignored cross-origin.

14. **Export — whole batch as ZIP.**
    - [C] Fetches each **succeeded** item's `imageUrl` from Blob (CORS-enabled) and zips client-side (streaming zip in the browser), naming entries by item index/filename. *(decision: client-side zip keeps the server stateless and avoids a function holding all bytes; failed items are skipped, with a `MANIFEST.txt` noting skips.)* Saves `batch-{jobId}.zip`.
    - [U] A progress hint while zipping; then the file downloads.

---

## 3. Item lifecycle state machine

```
                 enqueue (job created / targeted retry)
                          │
                          ▼
                     ┌─────────┐
        ┌───────────▶│ QUEUED  │
        │            └────┬────┘
        │   pool slot + provider token acquired
        │                 │ (1) start attempt
        │                 ▼
        │            ┌─────────┐
        │            │ RUNNING │◀──────────────┐
        │            └────┬────┘               │ (4) retry re-entry
        │   provider call resolves             │     (same provider,
        │      │       │        │              │      attempt++)
        │ (2a) │  (2b) │   (2c) │              │
        │success  retryable   fatal            │
        │  │     error        error            │
        │  ▼       │            │               │
        │ ┌──────────┐         │        backoff(base*2^a + jitter)
        │ │SUCCEEDED │         │        elapsed, attempts<cap ──┘
        │ └──────────┘         │
        │  (terminal)          │ (3) classify:
        │                      │   • retryable & attempts<cap  → schedule retry (→4)
        │                      │   • retryable & attempts==cap → FAILOVER
        │                      │   • fatal (auth/quota)        → FAILOVER (immediate)
        │                      │   • fatal (content-policy/    → FAILED (per-item)
        │                      │     invalid-input)
        │                      ▼
        │            ┌──────────────────┐
        │   (5)      │ FAILOVER decision │
        └────────────┤ next provider in  │
   re-enter RUNNING  │ chain exists?     │
   on next provider  └───────┬───────────┘
   (attempt counter         │ no provider left
    resets per provider)    ▼
                       ┌────────┐
                       │ FAILED │  (terminal; error={code,message,lastProviderId})
                       └────────┘
                            │ user clicks Retry  ──▶ back to QUEUED (chain reset)
```

> **Empty/corrupt 200 (decision, §5k).** A provider returning HTTP 200 with an **empty / zero-byte / undecodable** image is classified **`retryable_error`** at the result-validation step — it never silently becomes a result and never short-circuits to fatal. It then follows the normal retry→failover path.

**Transitions, triggers, side effects:**

| # | From → To | Trigger | Side effects |
|---|---|---|---|
| (1) | queued → running | Worker acquires a pool slot **and** a provider token | Append Attempt `{providerId, startedAt}`; emit `item.status{running}`; set `ATTEMPT_TIMEOUT_MS` + AbortSignal; (debug) log attempt-start. |
| (2a) | running → **succeeded** | Provider returns a **valid** image | Validate non-empty/decodable; write result Blob at per-item key `results/{jobId}/{itemId}.{ext}` (last writer wins); set Attempt `success`; set `result`; account quota; **log** attempt line w/ `meta.latencyMs,model`; emit `item.result` then `job.progress`. |
| (2b) | running → running (via 3→4) | Retryable error (429/5xx/timeout/"temporarily unavailable"/**empty-or-corrupt 200**) **and** attempts < cap on this provider | Set Attempt `retryable_error`; **log** attempt line w/ `errorCode`; compute backoff `base*2^attempt + jitter` (capped); schedule re-entry; item stays `running` to the client (no terminal SSE). |
| (2c) | running → failover/fail (via 3) | Fatal error or retry cap reached | Set Attempt `fatal_error` or terminal `retryable_error`; **log** attempt line. |
| (3) | classify | On any non-success | Decide retry vs failover vs fail per §5 rules. |
| (4) | running → running | Backoff timer elapsed, attempts<cap | New Attempt **same provider**, `attemptNumber++`, fresh `idempotencyKey=hash(itemId+attemptNumber)`; re-call. |
| (5) | running → running | Failover: provider attempts exhausted **or** immediate-fatal(auth/quota) **and** a next provider exists | New Attempt with **next** `providerId`; **per-provider attempt counter resets to 0**; switch to that provider's rate bucket; **log** a `failover` line (from→to); if next provider `supportsImageReference=false`, set degradation flag (see §5c). Emits nothing terminal yet. |
| — | failover → **failed** | No next provider remains | Set item `status=failed`, `error={ code, message, lastProviderId }`; emit `item.error` then `job.progress{failed++}`. |
| — | content-policy/invalid-input | Fatal-per-item, **never** failover | Set item `status=failed` with `code=content_policy` (or `invalid_input`); emit `item.error`. UX: the tile's Retry is presented as **"adjust brief / replace image to retry"** (a plain retry would deterministically fail the same input — §5i). |
| — | failed → **queued** | User clicks Retry (`POST .../retry` → `200 { ok: true }`) | **De-dup guard:** only a currently-`failed` item is re-enqueued; a retry POST for an item already `queued|running|succeeded` is a **no-op** that still returns `200 { ok: true }` (§5p). On a real retry: reset chain to provider #1, reset per-provider counters, clear `error`, re-enqueue; emit `item.status{queued}`. New attempt numbers ⇒ no duplicate result (per-item result key is overwritten last-writer-wins). |

---

## 4. Job lifecycle state machine

```
   POST /api/jobs ──▶ ┌─────────┐
   (per-IP RL,        │ RUNNING │  (≥1 item not terminal)
    validated,        └────┬────┘
    items enqueued)        │ all items terminal (succeeded|failed)
                           ▼
              ┌────────────┴────────────┐
         failed == 0              failed ≥ 1   (incl. failed == N → done=0)
              │                          │
              ▼                          ▼
       ┌────────────┐      ┌────────────────────────┐
       │ COMPLETED  │      │ COMPLETED_WITH_ERRORS   │
       └────────────┘      └────────────────────────┘

   (separate trigger — NOT item aggregation)
   whole-job init/infra failure (e.g. batch reference
   normalization fails before any item runs) ──▶ ┌────────┐
                                                 │ FAILED │
                                                 └────────┘
```

**Aggregation rules** (evaluated whenever an item reaches a terminal state):

- Job stays `running` while any item ∈ {queued, running}.
- On the **last** item becoming terminal:
  - `failed == 0` → `completed`.
  - `failed ≥ 1` → `completed_with_errors` (this **includes** `failed == N`, reported as `done=0, failed=N`). **(decision)** All-items-failed is *not* job `failed` — see §0.
- **Job `failed` is a non-aggregation trigger only.** The orchestrator sets job `failed` when the job itself cannot run (internal orchestrator/init error, or batch-level reference normalization failing before any item is attempted). It emits `job.done { status:"failed" }` and closes. (A `POST /api/jobs` that fails *validation* returns 4xx and creates **no** job, so it never produces a `failed` job — §5j.)
- **Targeted retry while the job is already terminal** re-opens the job: job → `running`, that item → `queued`; on completion the job re-aggregates by the same rules (so `completed_with_errors` can become `completed`). The client must **reopen the stream** to see live updates (§2.12 / §5d).
- **Targeted retry while the job is still `running`** (a failed item retried before the batch finished): the item simply returns to `queued`; the job is already `running`, so there is **no re-open** — it just keeps draining (§5p).
- `job.progress { done, failed, total }` is emitted on **every** item terminal transition. `job.done { status }` is emitted **once** when the job first reaches a terminal status, and **again** after any retry-driven re-completion.
- **No catastrophic job failure from individual items:** a job never reaches `failed` because of item outcomes — even all-items-failed is `completed_with_errors`.

---

## 5. Edge / error FLOWS (each as its own narrative)

### (a) Transient error → retry with backoff + jitter
1. Item is `running` on Gemini, attempt 0, `idempotencyKey=hash(itemId+0)`.
2. Gemini returns `503` (or times out / `429` / "temporarily unavailable").
3. Retry engine **classifies** as retryable. Attempt 0 recorded `retryable_error` (logged with `errorCode`).
4. `attempts(0) < cap(3)` → schedule retry. Delay = `min(base*2^0 + jitter, maxDelay)`. Jitter is randomized (full/decorrelated) to avoid synchronized retry storms across the pool.
5. Timer elapses → new Attempt 1, `idempotencyKey=hash(itemId+1)`, **same provider**, same input. Item never left `running` from the client's view.
6. Gemini succeeds on attempt 1 → normal success path (§3 transition 2a). Tile renders. No failover, no badge.
   *DoD:* a single transient blip causes ≥1 silent retry and a successful tile; logs show two attempt lines with the same `itemId`; exactly **one** result object at `results/{jobId}/{itemId}.{ext}` (last write wins), no duplicate.

### (b) Provider exhausted → failover to next provider
1. Item on Gemini exhausts all 3 **attempts** (each a retryable error).
2. Engine: attempts exhausted **and** next provider (Cloudflare) exists → **failover** (logged from→to).
3. New Attempt with `providerId="cloudflare"`, per-provider attempt counter **reset to 0**, fresh `idempotencyKey`. Rate budget switches to Cloudflare's bucket (numbers from providers config).
4. Cloudflare (e.g. FLUX.2 **klein**, which supports edit/reference) succeeds → `item.result { providerId:"cloudflare", usedImageReference:true }`. Tile renders, meta shows `CLOUDFLARE`.
   *DoD:* one provider's full failure does not fail the item; the attempt log shows 3 Gemini + ≥1 Cloudflare attempts; the `job` still trends to `completed`.

### (c) Failover lands on a provider with **no image reference** → prompt-only degradation + badge
1. Failover reaches Cloudflare on **schnell/SDXL** (`supportsImageReference=false`).
2. The adapter cannot consume the reference image; the **providers-owned prompt builder** assembles the prompt using the **cached style-text** instead of image conditioning. **Style-text source (decision):** the text description of the reference style is produced **once per job**, at job creation, by the **providers-owned style-text extractor** (alongside reference normalization) — derived from the reference image(s) (and optionally the brief) — and cached on the job. It is **not** authored ad hoc by the backend and **not** re-derived per item. Seed strategy still applied where supported.
3. Generation succeeds. `GenerateResult.usedImageReference=false`. Item `result.usedImageReference=false`.
4. `item.result { ..., usedImageReference:false }` → tile renders the image **plus** a muted `STYLE: PROMPT-ONLY` badge. This is the honest availability↔consistency trade-off.
   *DoD:* the tile shows a real image, the badge is present, metadata records `usedImageReference:false`; the prompt-only-share metric increments (§9).

### (d) All providers exhausted → item.failed + targeted retry
1. Item fails through Gemini (3 attempts) → Cloudflare (3 attempts) → Replicate if configured (3 attempts) — all retryable/fatal.
2. No next provider remains → item `status=failed`, `error={ code:"all_providers_exhausted" | last code, message, lastProviderId }`.
3. `item.error { itemId, code, message, lastProviderId }` → tile flips to `FAILED`, shows human-readable cause + last provider tried + a `RETRY` button. `job.progress{failed++}`.
4. User clicks Retry → `POST /api/jobs/:id/items/:itemId/retry` → `200 { ok: true }`. Item → `queued`, chain reset to provider #1, counters reset, `error` cleared, re-enqueued; job → `running` if it was terminal (and the **client reopens the stream** — §2.12). New attempt numbers ⇒ no duplicate result on eventual success (per-item key overwritten).
   *DoD:* a fully-failed item is visibly failed with a real reason and a working retry; retry re-enters the full chain; on success the job re-aggregates (possibly to `completed`) and re-emits `job.done`.

### (e) Partial failure → completed_with_errors
1. Of N items, some reach `succeeded` and ≥1 reaches `failed` (per (d)).
2. When the last item goes terminal with `failed ≥ 1`, job → `completed_with_errors` (this covers `failed==N` as `done=0`).
3. `job.done { status:"completed_with_errors" }`. UI: indicator `8 of 10 done · 2 errors`; succeeded tiles exportable; failed tiles offer Retry. ZIP export includes only succeeded items (with a `MANIFEST.txt` note).
   *DoD:* the batch never "crashes"; succeeded posts are fully usable; failed ones are individually retryable; job status precisely reflects the mix.

### (f) SSE disconnect → reconnect via Last-Event-ID / snapshot, no lost results
1. Connection drops mid-batch (network/function recycle). The browser EventSource auto-reconnects.
2. Client reconnects to `GET /api/jobs/:id/stream` sending `Last-Event-ID: <last seq it saw>`.
3. Server reads the cursor, **replays** all buffered events with `id > Last-Event-ID`, then resumes live forwarding. The client merges the delta; tiles already rendered stay rendered; missed `item.result`/`item.error`/`job.progress` are applied.
4. Fallback path: if the event buffer can't satisfy the cursor (truncated/lost), the client calls `GET /api/jobs/:id` for a **full Job snapshot** and rebuilds the grid wholesale, then reopens the stream. *(decision: snapshot is the source of truth; SSE is the fast path; they converge because state is server-authored.)*
5. If the job already finished while disconnected, the snapshot/replay yields all terminal results + `job.done`; the client closes the stream.
   - **MVP honesty (conditional guarantee).** "Zero already-produced results lost" holds **only if the orchestrator process survived**. In the MVP the event buffer **and** `GET /api/jobs/:id` live in the *same* in-memory process; if that process was recycled, both are gone and the snapshot fallback 404s (§5n) — the batch is abandoned (§5r / §11). The unconditional no-loss guarantee belongs to the deferred durable queue.
   *DoD:* after a forced disconnect **without process loss**, zero produced results are lost and the grid matches the server snapshot; under process loss, the client degrades gracefully via §5n rather than hanging.

### (g) Gemini daily quota approaching → pre-emptive switch
1. The per-provider usage counter for Gemini crosses the **soft threshold** configured in **providers config** (e.g. near the per-day budget). The backend reads thresholds from providers config — it does not hardcode them.
2. The orchestrator **pre-emptively** chooses Cloudflare as the starting provider for **newly-started** items (it does not interrupt in-flight Gemini attempts). This is a quota-driven start-position shift, distinct from error-driven failover.
3. If crossed mid-batch, remaining `queued` items begin at Cloudflare; their tiles may carry the prompt-only badge if they land on a non-reference model (per (c)).
4. A **hard** quota error (Gemini returns quota-exhausted/daily-`429`) is **immediate-fatal for that provider** → instant failover (no retries burned), per §3 transition (5).
   *DoD:* as Gemini nears its cap, the system shifts to Cloudflare without a wall of failures; quotas are config-driven (no redeploy).

### (h) Invalid upload rejected pre-batch
1. During add (step 2/3), a file fails client validation (wrong MIME, > 10 MB, bad/oversized resolution, or would exceed N=20).
2. The file is **never added** to the pending set; an inline, file-named error appears (`"logo.gif — unsupported format (png/jpg/webp only)"`). Generate stays gated until the selection is valid.
3. **Defense in depth.** Even on a client bypass: `POST /api/uploads` re-validates `contentType` and caps `size` on the signed token; `POST /api/jobs` is **per-IP rate-limited** (README §8 / TZ §10) and validates URL shape/counts/params enum. An invalid job payload is rejected with a 4xx **before** any item is created — no Job, no provider call.
   *DoD:* invalid inputs cannot start a batch; the user gets a precise reason; the server independently enforces the same rules; abusive request volume is throttled per IP.

### (i) Content-policy rejection (fatal-per-item)
1. A provider returns a moderation/content-policy rejection (or invalid-input) for one item.
2. The retry engine classifies it **fatal, non-retryable, non-failover** (retrying or switching providers won't change the verdict for the same input). Attempt recorded `fatal_error`.
3. Item → `failed`, `error={ code:"content_policy", message:"<human-readable>", lastProviderId }`. `item.error` emitted; tile shows `FAILED — content policy`. The batch continues; other items unaffected.
4. **Retry UX (decision — resolving the dead-end).** A plain re-run of the *same fixed product input* would fail identically. So the failed tile does **not** offer a bare "Retry"; it offers **"Adjust brief / replace image"**: the user can edit the batch brief or **re-upload a replacement product image** for that tile, which uploads a new `blobUrl` and only then enables retry (effectively a new attempt with changed input). This avoids a guaranteed-to-fail retry loop.
   *DoD:* a policy rejection fails exactly one item with a clear cause, never triggers pointless retries/failover, never sinks the batch, and the UI guides the user to change the input rather than re-submit it unchanged.

### (j) `POST /api/jobs` fails → optimistic placeholders rolled back
1. The client rendered N optimistic placeholders, then `POST /api/jobs` returns 4xx (validation/rate-limit) / 5xx, or the network drops.
2. **(decision)** With no `jobId`, the client **rolls back**: removes the placeholder grid, restores the editable pre-launch form (uploads/params intact), clears the busy button, and shows an inline error (e.g. "Couldn't start the batch — <reason>. Try again."). On a 429 (per-IP), the message names the throttle and the user can retry shortly.
3. No Job, no Items, no stream — nothing to reconcile or leak on the server side.
   *DoD:* a failed launch never leaves orphaned tiles or a half-open stream; the user can correct and re-submit.

### (k) Provider returns HTTP 200 but empty/corrupt/zero-byte image
1. Gemini (or any adapter) returns 200 but with an empty body, zero-byte image, or bytes that fail to decode.
2. **(decision)** The backend's result-validation step (before the Blob write) rejects it and classifies the attempt **`retryable_error`** — it is never written as a result and never treated as success.
3. It then follows the normal retry→failover path (§3 (2b)/(5)); persistent corruption across the chain ends as `item.failed` like any other exhausted item.
   *DoD:* a malformed 200 can never surface as a broken/blank tile; it is retried/failed-over and logged with an `errorCode`.

### (l) Fallback model can't honor the requested aspectRatio
1. Failover lands on a model with fixed/limited output sizes (e.g. SDXL) that cannot natively produce `4:5` or `9:16`.
2. **(decision — providers boundary):** honoring `GenerateInput.aspectRatio` is the **adapter's** responsibility. The adapter generates at the model's nearest supported size and **post-processes** (crop/pad to the requested ratio) so the returned image matches `aspectRatio`. The contract "output matches the requested ratio" holds regardless of provider.
3. If an adapter genuinely cannot satisfy the ratio, it returns a `fatal_error` (invalid-input) rather than a wrong-ratio image, and the item fails-per-item with a clear cause — never a silently mis-sized result.
   *DoD:* every rendered tile matches the requested aspect ratio, or fails honestly; no off-ratio images slip through.

### (m) Client-side export & Blob CORS (single + zip)
1. Single-post and zip export both fetch/anchor-download **cross-origin** Vercel Blob URLs from the browser.
2. **(decision)** Result Blob is public-read with **CORS configured to allow the app origin**; the single download uses `<a download>` and falls back to `fetch → blob → saveAs` when `download` is ignored cross-origin. The zip path `fetch`es each succeeded `imageUrl` (CORS-enabled) and zips in-browser.
3. Without CORS, cross-origin `fetch` for the zip would fail and `download` would be ignored — so CORS is a required deploy config, not optional.
   *DoD:* single and zip downloads work in the browser against cross-origin Blob URLs; failed items are skipped from the zip with a manifest note.

### (n) `GET /api/jobs/:id` returns 404 (snapshot-fallback path)
1. The reconnect fallback (§5f step 4) or a fresh open calls `GET /api/jobs/:id`, but the job is unknown — evicted from the in-memory store, an invalid id, or the process was recycled (§5r).
2. **(decision)** The client treats 404 as "batch no longer available": it stops reconnecting, shows a clear terminal state ("This batch is no longer available — start a new one."), and keeps any already-rendered results visible (they may still be downloadable from their Blob URLs). It does **not** spin retrying the stream.
   *DoD:* a 404 snapshot yields a clear, non-hanging UI rather than an infinite reconnect loop.

### (o) Double-click / duplicate `POST /api/jobs`
1. The busy-state button mitigates client-side, but a fast double-submit or retry-after-timeout could still issue two `POST /api/jobs`.
2. **(decision)** Each Generate click carries a stable `Idempotency-Key` (UUID). The server returns the **same** `{ jobId }` for a duplicate key within a short window, so two clicks never create two jobs. (Additionally, a lightweight "one active job at a time" guard may reject a second concurrent create for the single user.)
   *DoD:* one Generate gesture yields exactly one Job, even under double-click or client retry.

### (p) Duplicate / concurrent Retry on the same item
1. The user double-clicks Retry, or retries an item that is already re-queued/running.
2. **(decision)** The retry endpoint is **de-duped by item status**: it only re-enqueues an item currently in `failed`. For an item already `queued|running|succeeded`, it is a **no-op** and still returns `200 { ok: true }`. No duplicate processing, no duplicate attempts.
3. Retry of a failed item **while the job is still running** simply re-queues it (job stays `running`, no re-open). Retry **after the job is terminal** re-opens the job (§4) and the client reopens the stream.
   *DoD:* repeated/concurrent retries cannot spawn duplicate work; the response is always `200 { ok: true }`.

### (q) Initial EventSource connect failure (stream never opens)
1. Distinct from a mid-stream drop: the *first* `GET /api/jobs/:id/stream` never establishes.
2. **(decision)** The client relies on EventSource's built-in reconnect (with `Last-Event-ID` once any event is seen) and, in parallel, fetches `GET /api/jobs/:id` to render the current snapshot so tiles aren't stuck on optimistic placeholders. If the snapshot 404s, it degrades per §5n.
   *DoD:* a failed first connect still yields a populated grid (from the snapshot) and keeps trying to open the live stream, rather than freezing on `QUEUED` placeholders.

### (r) Function recycle mid-batch (MVP abandonment — honest limitation)
1. In the MVP, orchestration runs **in-flight inside the streaming handler** with **in-memory** state (README §4.2 note; TZ §5.3/§9.3/§11). A function/process recycle (timeout, redeploy, eviction) destroys both the orchestrator and the state store.
2. **Consequence:** `queued`/`running` items never reach a terminal state; the event buffer and `GET /api/jobs/:id` are gone (→ §5n 404). The Terminal invariant holds only *within one function lifetime* (§0).
3. **Why this is acceptable for MVP / how it's recovered:** this is the precise reason the **durable queue** (Vercel Queues) is full-product scope (TZ §9.3/§15). In the MVP, the user's recourse is to start a new batch; already-produced result Blobs remain downloadable by URL. For large N (e.g. N=20 at ~10 RPM Gemini ⇒ ≥~2 min of drain) the batch can exceed the streaming-handler lifetime — Fluid Compute + a tuned function limit mitigate but do not eliminate this; the durable queue does.
   *DoD:* the doc states plainly that an MVP recycle abandons the batch, that this is a known, scoped trade-off, and that no false "always recovers" promise is made.

### (s) Multiple tabs / concurrent jobs (shared global pool & quota)
1. The single user could open multiple tabs or launch a second batch while one is running.
2. **(decision)** The worker pool (`POOL_SIZE`) and per-provider token buckets + quota counters are **process-global** — shared across **all** concurrent jobs in that process, not per-job. So total Gemini calls/min never exceed the bucket regardless of how many batches run.
3. The job-creation idempotency / "one active job" guard (§5o) means concurrent batches are not the expected path for the single user; if they do occur, they share the global pool fairly (FIFO across the combined ready set), and per-batch SSE streams remain independent.
   *DoD:* concurrent batches cannot collectively breach provider rate limits; pool/quota scope is explicitly global, not per-job.

### (t) Orphan upload blobs (× removal / uploaded-but-never-generated)
1. A product/reference file uploaded eagerly (§2.4) may be removed via × afterward, or the user may abandon the page without ever clicking Generate.
2. **(MVP honesty)** Those upload Blob objects are **not** reclaimed in the MVP — they leak. (Result blobs do **not** leak, because the per-item result key is attempt-independent/last-writer-wins — §0.) Blob lifecycle/cleanup is explicitly deferred to full-product (TZ §11: "Vercel Blob (+ lifecycle/cleanup)").
   *DoD:* the doc acknowledges the upload-blob leak as a known MVP limitation rather than implying full cleanup.

---

## 6. Concurrency behavior as a flow

```
items[] ──▶ READY QUEUE ──▶ [ worker pool, size = POOL_SIZE (env, default 5) ]
                                 │  each worker, per item:
                                 │   1. acquire pool slot
                                 │   2. acquire token from CURRENT provider bucket
                                 │      (RPM/quota from PROVIDERS CONFIG; Gemini ~10 RPM)
                                 │   3. run attempt (ATTEMPT_TIMEOUT_MS + AbortSignal)
                                 │   4. on retry-backoff: release slot + token, re-queue
                                 ▼
                          provider call ──▶ success | retryable | fatal
```

1. **Bounded pool.** At most `POOL_SIZE` items are `running` at once (env, default `5`; spec range 4–6, Architecture pins `POOL_SIZE=5`). The rest stay `queued` in submission order. This caps parallelism against provider rate limits and keeps the UI responsive (NFR-2). The pool is **process-global** (§5s).
2. **Per-provider token bucket.** Before each provider call, the worker takes a token from **that provider's** bucket. Bucket sizes/RPM come from **providers config** (Gemini ~10 RPM; Cloudflare/Replicate their own). Tokens refill on a timer. If no token is available, the worker waits (or the item yields back to `queued`) until refill — so the pool can be 5 wide but still never exceed Gemini's RPM.
3. **Backoff vs slot occupancy** *(decision):* while an item is in **retry backoff**, it **releases its pool slot and rate token** and re-queues with a "not-before" timestamp, so a sleeping retry never starves throughput. The pool immediately pulls the next `queued` item. (Holding the slot through the sleep is rejected because it caps useful concurrency under 429 storms.)
4. **Draining.** The orchestrator loops: while (ready items exist AND a free pool slot AND a provider token), start the next item. It re-evaluates whenever a slot frees (item terminal or entered backoff), a token refills, or a backoff timer fires.
5. **Failover & rate-limit interplay.** When an item fails over to Cloudflare, it contends for the **Cloudflare** bucket, not Gemini's — so a Gemini 429 storm draining its bucket does not block Cloudflare progress.
6. **Fairness.** Ready queue is FIFO by submission index, so tiles tend to start in order even though they finish out of order; targeted-retry items re-enter the tail of the queue.

---

## 7. Data & asset flow

```
 [browser file] ──signed PUT──▶ [Vercel Blob: uploads/...]
        ▲ POST /api/uploads { filename, contentType, kind } → {uploadUrl, blobUrl}
        │
 POST /api/jobs { productImageUrls[], referenceImageUrls[],
                  params:{ aspectRatio, brief?, perImageHints?:Record<string,string> } }
        │   (+ Idempotency-Key header)            (URLs, not base64)
        ▼ (server: per-IP RL, validate, create Job + N Items)
 keep perImageHints on Job.params (no Item field) ─▶ resolved at composition root per item
 reference normalization (providers module, once/job) ─▶ normalized reference Blob URLs (cached)
 style-text extraction   (providers module, once/job) ─▶ style description (cached, for prompt-only)
        │
 per attempt: prompt = promptBuilder(template, brief, params.perImageHints?.[item.productImageUrl], styleText)   [providers]
              GenerateInput { productImageUrl, referenceImageUrls:<normalized URLs>,
                              prompt, aspectRatio, seed:<orchestrator batch seed> }
        │     idempotencyKey = hash(itemId + attemptNumber)
        ▼
 provider.generate(input, signal) ─▶ GenerateResult { imageBytes|url, providerId,
                                                       usedImageReference, meta{latencyMs,model} }
        │  (backend validates: non-empty/decodable; sole writer)
        ▼
 [Vercel Blob: results/{jobId}/{itemId}.{ext}]   (per-item, attempt-independent, last writer wins)
        │  → public imageUrl (CORS: app origin)
        ▼
 item.result(imageUrl) ─SSE─▶ tile renders ─▶ export (single = direct Blob URL;
                                                     zip = client fetches all + zips)
```

1. **Signed upload.** Client gets a signed `uploadUrl` and PUTs bytes straight to Blob; the function never buffers image bytes. The `POST /api/uploads` body is `{ filename, contentType, kind }` (no client-declared size); the signed token authoritatively constrains max size at Blob. `blobUrl` is the durable handle.
2. **Generation input = URLs.** `POST /api/jobs` carries only `blobUrl`s + params (incl. `perImageHints` map). Providers receive **URLs** (normalized reference URLs), never base64 bodies.
3. **Reference normalization once per job** (providers-owned module, backend-invoked). References are fetched/resized/encoded a single time → normalized reference Blob URLs, cached and reused for all N items (latency mitigation, TZ §6.3 / risk table).
4. **Style-text once per job** (providers-owned module). A text description of the reference style is derived once and cached for prompt-only fallbacks (§5c).
5. **Per-image hint resolution.** `perImageHints` stays on `Job.params`; the composition root resolves `params.perImageHints?.[item.productImageUrl]` when building each Item's `GenerateInput` and passes it to the prompt builder per attempt — no persisted `Item` field.
6. **Idempotency key per item-attempt.** `hash(itemId + attemptNumber)` flows into the provider call for redelivery de-dup.
7. **Result key — per item, attempt-independent.** Result bytes are written by the **backend (sole writer)** to `results/{jobId}/{itemId}.{ext}` — **last writer wins** (Architecture §5.5/§8.1). Any successful attempt overwrites the same object, so `result.imageUrl` always points at the one stable per-item object; no orphan/non-winning result blobs accumulate.
8. **Result delivery & export.** Server returns only the `imageUrl` over SSE; the browser loads pixels directly from Blob. Single-export = direct Blob download; ZIP-export = client fetches each succeeded `imageUrl` and zips client-side — both require **Blob CORS allowing the app origin** (§5m).

---

## 8. SSE event flow

Event channel: `GET /api/jobs/:id/stream`. Every event carries `id: <seq>` (monotonic per job) for `Last-Event-ID` replay. Event names/shapes are exactly those in Architecture §6 / TZ §8.2.

| Event | Data | Fires when | Frequency |
|---|---|---|---|
| `item.status` | `{ itemId, status }` | An item enters `queued` (re-enqueue/retry) or `running` (attempt start). | Per status edge the UI must reflect (not per silent retry). |
| `item.result` | `{ itemId, imageUrl, providerId, usedImageReference }` | An item reaches `succeeded` and its result Blob is written. | Once per item success (and again after a successful retry). |
| `item.error` | `{ itemId, code, message, lastProviderId }` | An item reaches terminal `failed` (all providers exhausted, or fatal content-policy/invalid-input). | Once per item failure. |
| `job.progress` | `{ done, failed, total }` | **Every** item terminal transition; plus an initial `{0,0,N}` at stream open. | N+1+ times across a run. |
| `job.done` | `{ status }` | Job first reaches `completed \| completed_with_errors \| failed`; re-emitted after a retry re-completes the job. | ≥1 time. |

> The **per-batch summary** (§9) is **not** an SSE event — it is a structured **log** emitted server-side at job terminal. The client learns terminal state from `job.done`.

**Ordering & lifecycle guarantees.** Per item: `item.status(running)` precedes that item's `item.result`/`item.error`; each terminal item event is immediately followed (or accompanied) by a `job.progress`. On reconnect, the server replays the exact `id`-ordered sequence after `Last-Event-ID`, so the client reconstructs identical ordering. After `job.done` with a terminal status and no pending retries, the server closes the stream and the client stops auto-reconnecting — **but retains the ability to reopen** (a later Retry on a terminal job reopens the stream to receive the new `item.status`/`item.result`/`item.error` and the re-emitted `job.done`; §2.12 / §4 / §5d).

```
open ─▶ job.progress{0,0,N}
      ─▶ item.status{i,running} ─▶ item.result{i,...}   ─▶ job.progress{1,0,N}
      ─▶ item.status{j,running} ─▶ item.error{j,...}    ─▶ job.progress{1,1,N}
      ... (out of order across items) ...
      ─▶ job.done{completed_with_errors} ─▶ (stream closes; per-batch summary logged)
   ── reconnect (Last-Event-ID=k) ─▶ replay events id>k ─▶ resume/live
   ── retry on terminal job ─▶ REOPEN stream ─▶ item.status{queued}… ─▶ job.done (re-emit)
```

---

## 9. Observability flow (NFR-6 / README §8 / TZ §12)

Observability is part of the flow, emitted from named points in the item lifecycle — not an afterthought.

**Per-item-attempt structured log line** (one per attempt, at attempt end — §3 (2a)/(2b)/(2c)):
```
{ ts, level, jobId, itemId, attempt: attemptNumber, providerId,
  outcome: "success" | "retryable_error" | "fatal_error",
  latencyMs,            // GenerateResult.meta.latencyMs on success; measured wall-time otherwise
  model?,               // GenerateResult.meta.model on success
  errorCode? }          // set on retryable/fatal outcomes
```
- **Emission points:** attempt start (optional debug `attempt.start`); attempt end (the line above); failover (`failover { jobId, itemId, from, to }`, §3 (5)); prompt-only degradation increments the prompt-only metric (§5c).
- **`GenerateResult.meta` is surfaced** here — `latencyMs` and `model` flow from the provider result into the attempt log and into the latency metric, rather than being discarded.

**Metrics** (derived from the attempt stream; Vercel logs in MVP, external sink in full product — TZ §12):
- **Per-provider success rate** (success vs error attempts per `providerId`).
- **Failover share** (items needing ≥1 failover / total items).
- **Prompt-only share** (succeeded items with `usedImageReference=false` / total succeeded).
- **Generation latency p50/p95** per provider, from `meta.latencyMs`.

**Per-batch summary** (one structured line at job terminal — emitted in §2.12 alongside `job.done`):
```
{ jobId, status, total, succeeded, failed,
  byProvider: { gemini:{attempts,successes}, cloudflare:{…}, replicate?:{…} },
  failoverShare, promptOnlyShare, latencyP50Ms, latencyP95Ms, wallMs }
```
This satisfies TZ §12's "aggregated batch trace on completion (how many success/failed, how much each provider did)."

---

## 10. Configuration & env knobs

All reliability/concurrency knobs are **config (env)**, not hardcoded (FR-5 / TZ §6.4/§9.1). Provider-specific numbers (RPM, daily quota, soft threshold, seed support, model order) live in **providers config** and are **consumed** by the backend.

| Knob | Default | Owner / source | Notes |
|---|---|---|---|
| `POOL_SIZE` | `5` | backend (env) | Pool size; spec range 4–6 (Architecture pins 5). |
| `ATTEMPT_CAP` | `3` total/provider | backend (env) | Attempts `0..cap-1`; reaching cap → failover. |
| `ATTEMPT_TIMEOUT_MS` | `60000` | backend (env) | Per provider call; timeout = retryable. |
| `BACKOFF_BASE_MS` / `BACKOFF_MAX_MS` / jitter | env | backend | `base*2^attempt + jitter`, capped. |
| Provider chain order | `gemini → cloudflare → replicate*` | providers config | Replicate only if configured. |
| Per-provider RPM / daily quota / soft threshold | per provider (e.g. Gemini ~10 RPM, ~500/day) | **providers config** | Backend rate limiter/quota counters consume these; **changeable without redeploy** (TZ §6.4). |
| `MAX_ITEMS` (N bound) | `20` | backend (env) | `1 ≤ N ≤ 20`. |
| Per-IP rate limit on `POST /api/jobs` | env | backend | README §8 / TZ §10. |

**Secrets/URLs env** (unchanged from README §8 / TZ §14): `GEMINI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `REPLICATE_API_TOKEN` (opt.), `BLOB_READ_WRITE_TOKEN`, and full-product `DATABASE_URL`, `KV_URL`.

---

## 11. MVP durability boundary (honest limitation)

The MVP runs **in-flight orchestration inside the streaming Route Handler** over **in-memory** state (README §4.2; TZ §5.3/§9.3/§11). This has a hard boundary the rest of this doc is calibrated against:

- **A function/process recycle abandons the batch.** The orchestrator, the event buffer, and `GET /api/jobs/:id` all live in one process; if it recycles (timeout, redeploy, eviction), in-flight `queued`/`running` items never reach terminal and the snapshot 404s (§5n/§5r).
- **The Terminal invariant is "within a single function lifetime" only** (§0). Per-attempt timeouts + attempt caps + failover exhaustion guarantee forward progress *while the process lives*.
- **Reconnect / no-loss guarantees (§5f) are conditional** on the orchestrator surviving; under process loss the client degrades gracefully (§5n) rather than hanging.
- **Large-N exposure.** N=20 at ~10 RPM Gemini ⇒ a drain of ≥~2 minutes, which can approach/exceed the streaming-handler lifetime even with Fluid Compute. This is mitigated (Fluid Compute + tuned function limits) but not eliminated in MVP.
- **Why this is the right MVP trade-off:** durability is exactly what the **durable queue (Vercel Queues)** provides in full product (TZ §9.3/§15). Building it now would spend the time budget on infrastructure the evaluation explicitly de-prioritizes vs. the reliability/judgment core. The limitation is **stated, not hidden**.

---

## 12. Definition of Done per scenario

**Happy path (N=10, R=1, all succeed).**
- All 10 tiles reach `succeeded`; each renders its image from `results/{jobId}/{itemId}.{ext}`.
- First result tile ≤ ~15 s after Generate; results render progressively and out of order; the grid reflows correctly on mobile (NFR-7).
- Job ends `completed`; final `job.progress{10,0,10}` + `job.done{completed}` delivered; a per-batch summary is logged.
- Single-post export and ZIP export both download correct full-resolution images (Blob CORS in place).
- Logs: one structured line per item-attempt (with `latencyMs`/`model`); exactly 10 result objects (one per item key); no duplicate result blobs.

**Failover (forced Gemini failure).**
- Items that fail all 3 Gemini attempts succeed on Cloudflare; attempt logs show 3 Gemini + ≥1 Cloudflare per such item, plus a `failover` line.
- If the Cloudflare model lacks reference support, `usedImageReference:false`, the tile shows `STYLE: PROMPT-ONLY`, and the prompt-only-share metric increments.
- No item is failed solely due to Gemini being down; job trends to `completed`/`completed_with_errors`, never `failed` because of one provider (job `failed` is whole-job-infra only).

**Partial failure.**
- Succeeded tiles are fully usable and exportable; ≥1 failed tile shows a human-readable cause + last provider + a working Retry (content-policy tiles route to "adjust brief / replace image").
- Job ends `completed_with_errors` with `failed ≥ 1` (incl. the `failed==N`/`done=0` case); indicator shows accurate `done`/`errors` counts.
- A targeted retry re-enters the full provider chain, produces no duplicate result (per-item key overwritten), and can flip the job to `completed` on success (re-emitting `job.done` to a reopened stream).

**Reconnect.**
- After a forced SSE disconnect **without process loss**, the client reconnects via `Last-Event-ID` (or rebuilds from `GET /api/jobs/:id`), and **zero** already-produced results are lost; under process loss it degrades via §5n (404) instead of hanging.
- Post-reconnect grid state is identical to the server snapshot; the stream resumes live or cleanly ends if the job already finished.
- No duplicate tiles, no double-counted progress, no missed terminal events; a retry on a terminal job reopens the stream and delivers the new events + re-emitted `job.done`.