# Review: Task 8 — Cloudflare adapter (+ Replicate optional)

- **Date:** 2026-06-27
- **Implementer:** providers
- **Reviewer:** reviewer (fresh context)
- **Plan / Dispatch:** `batch-creative-studio-mvp-plan.md` (Task 8) · `batch-creative-studio-mvp-dispatch.md` (Group 3, In Progress)
- **Scope reviewed:** new `lib/providers/cloudflare.ts`, `lib/providers/replicate.ts`; modified `lib/providers/{config,registry,index,types,errors,gemini,reference-normalize}.ts`; `.env.example`. Read-only; no source edited. API shapes cross-checked against Context7 (`/llmstxt/developers_cloudflare_workers-ai_llms-full_txt`).

## Verdict

**Approve (LGTM).** The Cloudflare adapter implements `ImageProvider` correctly and the key acceptance criterion — accurate `supportsImageReference` — is met precisely. `cloudflareModelCaps()` (`config.ts:126-151`) classifies the configured model id into the right capability set, and the adapter derives `supportsImageReference` from `caps.acceptsImageInput` (`cloudflare.ts:79`): **true only for the FLUX.2 edit family, false for FLUX.1 [schnell] / SDXL.** Critically, the per-call `usedImageReference` is set from what was *actually* sent (`useReference = caps.acceptsImageInput && referenceImageUrls.length > 0`, `cloudflare.ts:88,109`), so a text-only model honestly reports `false` (prompt-only degradation). The request encoding branches by capability (multipart for the edit family, JSON for text-only) and the response decode branches on the response `Content-Type` (binary `image/*` stream vs base64 JSON envelope) — both verified against current Cloudflare docs. Bearer auth + account-id-from-env and `AbortSignal` are honored on every leg. Replicate implements the interface, is `supportsImageReference: true`, and is **gated off by default** — `registry.chain()` yields `[gemini, cloudflare]` and appends `replicate` only when `REPLICATE_ENABLED=true && REPLICATE_API_TOKEN`, with dedup. The `contentType?` contract addition is backward-compatible (optional; set in all three adapters; `tsc` clean). The Task-8 edit to `gemini.ts` is an isolated, regression-free addition of `contentType`. Boundary compliance is clean (only `lib/providers/**` + `.env.example`; `lib/types.ts`, `lib/orchestrator/**`, `lib/state/**` untouched; `package.json` unchanged — no SDKs). All four verifications pass. Findings are three Low and two Nit; none block.

## Real-API correctness (verified against Context7 — Cloudflare Workers AI)

| Adapter behavior | Context7 evidence | Faithful? |
|---|---|---|
| Endpoint `POST .../accounts/{id}/ai/run/{model}` | `cloudflare.ts:53,75` — matches `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/run/@cf/...` | Yes |
| Bearer auth from `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | `Authorization: Bearer {TOKEN}`; account id in path | Yes |
| FLUX.2 edit = `multipart/form-data`, `prompt` + binary `input_image_0..3` + `width`/`height`/`seed` | flux-2-dev REST example: multipart, `input_image_0..3` (max 512×512), `width`/`height` 256–1920, `seed` | Yes |
| Multipart: do NOT set `Content-Type` manually (let `fetch` set the boundary) | `cloudflare.ts:178` omits Content-Type for `FormData` | Yes (correct — manual header would break the boundary) |
| FLUX response = JSON `{ result: { image: "<base64>" } }` | flux-2-dev/klein docs: "receive a Base64 encoded image string", `data.result.image` | Yes |
| Text-only models = JSON `{ prompt, ... }` | SDXL/schnell REST examples: JSON `{ "prompt": ... }` | Yes |
| Decode branches on response `content-type` (binary vs JSON) | `cloudflare.ts:186-194` (binary) / `196-233` (JSON envelope) | Yes — robust to both |
| `extractBase64` reads `result.image` or `result` string | `cloudflare.ts:243-250` | Yes (matches `result.image` envelope) |
| Dimensions within 256–1920 | `aspectRatioDimensions` 1024×1024 / 1024×1280 / 1080×1920 (`config.ts:208-217`) | Yes |
| `supportsImageReference`: klein→true, schnell/SDXL→false | `config.ts:126-151`; architecture §4 table (`klein → true`, `schnell/SDXL → false`) | Yes |

Note on SDXL response: current Cloudflare docs show `@cf/stabilityai/stable-diffusion-xl-base-1.0` returning a **JSON** envelope (`data.result.image`), not only a binary `image/*` stream. The adapter's `Content-Type` branching handles **both** cases, so this is not a functional defect — only the docstring is imprecise (see N1).

## `CLOUDFLARE_MODEL=schnell` honesty trace (key acceptance check)

1. `cloudflareModel()` → `@cf/black-forest-labs/flux-1-schnell` (env override).
2. `cloudflareModelCaps()` → id includes `flux-1-schnell` → `{ acceptsImageInput:false, encoding:"json", supportsSeed:false, supportsDimensions:false }` (`config.ts:136-143`).
3. `supportsImageReference: caps.acceptsImageInput` → **false** (`cloudflare.ts:79`). The failover engine therefore knows this provider degrades.
4. `useReference = false && (refs>0)` → **false** → `buildJsonRequest` sends `{ prompt }` only (no width/height/seed, since those caps are false). No reference image is sent.
5. `usedImageReference: false` (`cloudflare.ts:109`) → the SSE `item.result.usedImageReference=false` → `STYLE: PROMPT-ONLY` badge (product-flow §5c). **Honest — reports false on text-only.**

## Replicate gating (acceptance: present but flagged off)

- Factory: `replicate: () => replicateEnabled() && replicateApiToken() ? createReplicateProvider() : undefined` (`registry.ts:45-46`).
- `replicateEnabled()` returns `false` unless `REPLICATE_ENABLED` env is exactly `"true"` (`config.ts:168-170`); `.env.example` ships `REPLICATE_ENABLED=false`.
- `chain()`: starts from `PROVIDER_CHAIN` (default `gemini,cloudflare`); appends `replicate` only `if (replicateEnabled() && !ids.includes("replicate"))`, then dedups via a `seen` set (`registry.ts:59-74`).
- **Default off → never in chain** (`[gemini, cloudflare]`). Even if a user lists `replicate` in `PROVIDER_CHAIN` while disabled, the factory returns `undefined` and it is omitted. Dedup prevents a double-append when both the env and the auto-append name it. Correct.

## Contract change review (`contentType?` on `GenerateResult`)

- `types.ts:60` adds `contentType?: string` (optional). Set by all three adapters: `gemini.ts:112` (`image.mimeType`), `cloudflare.ts:110` (`decoded.contentType`, derived via `sniffMime` magic-byte fallback), `replicate.ts:117` (`contentTypeForUrl`). 
- **Backward-compatible:** optional field; the Task-5 orchestrator/state (untouched, mtimes predate Task 8) still compile — `tsc --noEmit` is clean. The result store actually *threading* `contentType` into the `{ext}` derivation is explicitly Task-9 follow-up (per the `types.ts:50-58` doc comment), so nothing is left half-wired here.
- **`gemini.ts` regression check:** the only Task-8 change is the `contentType`/`extractImage` mimeType threading; error mapping, `usedImageReference` (`input.referenceImageUrls.length > 0`), abort handling, and SDK usage are unchanged from the Task-4-reviewed version. No behavioral regression; build + typecheck pass.

## Error mapping (neutral facts; consistent with gemini)

`cloudflare.ts:273-285` / `replicate.ts:247-259` reuse the shared `kindFromHttpStatus` + body-refinement pattern from `gemini.ts`. Spot-check:

| Failure | Cloudflare kind | Replicate kind | Engine decision (§5.3) | Consistent? |
|---|---|---|---|---|
| 429 (per-minute) | `rate_limit` | `rate_limit` | retry (honors `retryAfterMs`) | Yes |
| 429 + daily/neuron/quota/exhaust wording | `quota_exhausted` | `quota_exhausted` | fatal → advance | Yes |
| 402 Payment Required | (n/a) | `quota_exhausted` | fatal → advance | Yes (out-of-credit → advance) |
| 401/403 | `auth` | `auth` | fatal → advance | Yes |
| 5xx / network / unknown | `server` | `server` | retry → fail over | Yes |
| `unavailable`/`overloaded`/`capacity` wording | `unavailable` | `unavailable` | retry | Yes |
| 400/422 + safety/nsfw/moderat/policy | `content_policy` | `content_policy` | fatal → item fails | Yes |
| timeout / aborted | `timeout` | `timeout` | retry | Yes |
| 200 envelope `success:false` / empty / zero-byte | `server` | `server` (failed status) | retry → fail over | Yes — matches product-flow §5k |

`retryAfterMs` is parsed from the `Retry-After` header via the shared `retryAfterMsFromHeader` helper (added to `errors.ts` for the fetch adapters). Abort/timeout mapping (`mapThrown`) mirrors gemini. No `retryable` boolean leaks — neutral facts only, per architecture §4.

## Findings

### Low

**L1 — Oversized reference (>512×512) will likely 4xx on FLUX.2 and map to `invalid_input`/`content_policy` (fatal-per-item), not fail over.** Cloudflare caps each `input_image_N` at 512×512, but `reference-normalize.ts` deliberately does **no** pixel downscale (no image lib — `sharp` blocked by pnpm build-script policy; documented at `reference-normalize.ts:9-15` and re-acknowledged in `cloudflare.ts:28-30`). A real >512px reference therefore reaches Cloudflare and a resulting 400/422 maps (via the shared helper) to `invalid_input` → the retry policy fails the *item* without advancing to a tertiary provider. This is a **known, self-documented limitation** flagged for the Task-9 handoff and live-validated in Task 13; calling it out so it is not lost. Severity Low (acceptable-for-MVP, documented).

**L2 — 429 daily-vs-per-minute classification is wording-dependent (same fragility as gemini L2).** `cloudflare.ts:277` and `replicate.ts:251` distinguish a hard daily/quota 429 from a per-minute 429 purely by regex on the response body (`/\bdaily\b|neuron|quota|exhaust|exceeded/`). If a genuine daily/neuron exhaustion lacks that wording it is classified `rate_limit` (retryable) and burns the per-provider attempt cap before advancing — vs product-flow §5g's "immediate-fatal → instant failover, no retries burned." Correctness (eventual failover) is preserved; only efficiency suffers. Confirm wording in Task 13. Severity Low.

**L3 — `useReference` gates on reference-presence, not product-presence.** `cloudflare.ts:88` sends the multipart (image-conditioned) request only when `caps.acceptsImageInput && referenceImageUrls.length > 0`. For the FLUX.2 *edit* model the product image is the primary subject (`input_image_0`), yet if `referenceImageUrls` were ever empty the adapter would fall back to a text-only JSON request that omits the product image entirely. The R≥1 invariant (`normalizeReferences` throws if <1, product-flow §0) means this cannot happen in practice, so it is not an active bug — but the gating condition would read more defensively as "edit model" rather than "references present." Severity Low (invariant-protected).

### Nit

**N1 — SDXL response-format comment is outdated vs current Cloudflare docs.** `cloudflare.ts:20-21` states SDXL "stream[s] a BINARY image (`Content-Type: image/*`)"; current Workers AI docs show `@cf/stabilityai/stable-diffusion-xl-base-1.0` returning a JSON envelope (`data.result.image`). The code is correct (it branches on the actual response `Content-Type`, handling both), so this is purely a comment-accuracy nit — the content-type branching is the right robust design. Severity Nit.

**N2 — `CloudflareModelCaps.encoding` is defined but unused in request building.** `config.ts:119` declares `encoding: "multipart" | "json"`, but `cloudflare.ts` decides the request shape from `caps.acceptsImageInput` (+ refs presence), not `caps.encoding`. The field is documentation/dead-ish (only `acceptsImageInput`/`supportsSeed`/`supportsDimensions` are consumed). Either drive the branch off `encoding` or drop the field. Severity Nit.

## Acceptance-criteria check

| Criterion (Task 8) | Evidence | Met? |
|---|---|---|
| Cloudflare implements `ImageProvider` (`id`, `supportsImageReference`, `generate`) | `cloudflare.ts:77-114` — `id:"cloudflare"`, `supportsImageReference:caps.acceptsImageInput`, `generate(input,signal)` conforms to `types.ts:18-28` | Yes |
| `supportsImageReference` accurate (flux-2 → true; schnell/SDXL → false) | `cloudflareModelCaps` (`config.ts:126-151`) → `cloudflare.ts:79`; matches architecture §4 table | Yes |
| `usedImageReference` reflects what was actually sent (false on text-only) | `cloudflare.ts:88,109` (`useReference` = acceptsImageInput && refs>0); schnell trace → false | Yes |
| Request encoding branches by model (multipart edit / JSON text-only) | `cloudflare.ts:92-94`, `buildMultipartRequest` / `buildJsonRequest` | Yes (Context7-verified) |
| Response decode branches binary vs base64 JSON envelope | `decodeImageResponse` `cloudflare.ts:182-233` (content-type branch) | Yes |
| Bearer auth + account id from env; secrets server-side | `Authorization: Bearer` (`cloudflare.ts:133,178`); `cloudflareAccountId/ApiToken` in `config.ts`, not re-exported from barrel | Yes |
| `AbortSignal` honored | pre-call `throwIfAborted` (`:83`), passed to `fetch` (`:95`) + image fetches (`:154-157`), abort→timeout in `mapThrown`/JSON-read | Yes |
| Error mapping to neutral `ProviderError`/`kind`, consistent w/ gemini | `cloudflare.ts:253-295`; shared helpers in `errors.ts` | Yes |
| Replicate implements `ImageProvider`, `supportsImageReference:true` | `replicate.ts:72-121` | Yes |
| Replicate flagged off; not in chain by default | `registry.ts:45-46,59-74`; `config.ts:168-170`; `.env.example` `REPLICATE_ENABLED=false` | Yes |
| `chain()` = `[gemini, cloudflare]` default; appends replicate only when enabled (dedup) | `registry.ts:59-74` | Yes |
| Contract: `contentType?` added, backward-compatible | `types.ts:60` optional; set in all 3 adapters; `tsc` clean; threading deferred to Task 9 | Yes |
| `gemini.ts` edit no Task-4 regression | only `contentType` threading added; behavior unchanged; build/typecheck pass | Yes |
| Boundary: only `lib/providers/**` + `.env.example` | mtimes — providers cluster 00:50–00:56; `lib/types.ts` (Jun 26 23:20), `lib/orchestrator/**`/`lib/state/**` (00:27–00:34) untouched; no `*.test.ts`; `package.json` unchanged (no new deps) | Yes |

## Verification runs (re-run by reviewer)

| Command | Result |
|---|---|
| `./node_modules/.bin/biome check .` (raw binary — the rtk-proxied `pnpm exec biome check .` again emitted a spurious "Linter process terminated abnormally (possibly out of memory)" warning) | **Pass** — `Checked 38 files in 41ms. No fixes applied.` |
| `pnpm exec tsc --noEmit` | **Pass** — `TypeScript: No errors found` |
| `pnpm exec vitest run` | **Pass** — `PASS (0) FAIL (0)`; no test files (tests are Task 10 / `testing` agent — out of Task 8 scope) |
| `pnpm build` (`next build`, Next.js 16.2.9 Turbopack) | **Pass** — `Compiled successfully in 1226ms`; `Finished TypeScript`; routes `/`, `/_not-found`, `ƒ /api/uploads` generated |

## Summary

Approve. The Cloudflare adapter is faithful to the current Workers AI REST API (Context7-verified): correct multipart-vs-JSON request encoding by model class, robust binary-vs-base64-JSON response decoding by content-type, Bearer auth, and honored `AbortSignal`. The headline acceptance criterion — `supportsImageReference` accuracy — is exactly right, and `usedImageReference` honestly reflects what was sent (false on schnell/SDXL prompt-only). Replicate is implemented and correctly gated off; `chain()` is `[gemini, cloudflare]` by default with dedup'd opt-in append. The `contentType?` addition is backward-compatible and `gemini.ts` shows no regression. Boundary compliance is clean and `package.json` is untouched. L1 (oversized-reference 512px cap), L2 (429 daily-vs-minute wording), L3 (reference-vs-product gating), and N1/N2 are improvements/known limitations, not blockers — all appropriately deferred to the Task 13 live smoke.
