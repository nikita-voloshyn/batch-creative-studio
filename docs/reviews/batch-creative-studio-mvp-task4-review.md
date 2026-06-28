# Review: Task 4 — Provider abstraction + Gemini adapter

- **Date:** 2026-06-27
- **Implementer:** providers
- **Reviewer:** reviewer (fresh context)
- **Plan / Dispatch:** `batch-creative-studio-mvp-plan.md` (Task 4) · `batch-creative-studio-mvp-dispatch.md` (Group 2, In Progress)
- **Scope reviewed:** `lib/providers/{types,errors,config,registry,gemini,reference-normalize,prompt,index}.ts`, `package.json` / `pnpm-lock.yaml` (`@google/genai@^2.10.0`), `.env.example` (provider knobs). Read-only; no source edited. Verified the Gemini adapter against the installed `node_modules/@google/genai@2.10.0` type defs (`dist/genai.d.ts`).

## Verdict

**Approve (LGTM).** `lib/providers/types.ts` reproduces the architecture §4 contract **verbatim** — `ImageProvider` / `GenerateInput` / `GenerateResult` field-for-field, with the canonical `AspectRatio` re-exported from `lib/types.ts` (no double-ownership). The implementer's two interface flags are **both correct against the doc**: §4 lines 180/184 define `seed: number` (required, not `seed?`) and a single `imageBytes: Uint8Array | string` field — the looser Task-4 row wording is superseded by the doc, which is the authority. The Gemini adapter's SDK usage is **faithful to the installed `@google/genai@2.10.0` type defs** at every point I checked (constructor, `generateContent` params, `contents` parts, `config` members, response decode path, `ApiError.status`). Errors map to **neutral facts only** (`ProviderError` + `kind`, no `retryable` boolean) exactly as §4 mandates — the `kind`-over-boolean choice is the **right call**, not a defect. The `AbortSignal` is honored on three legs (pre-call guard, passed into `config.abortSignal`, and image fetches). Secrets stay server-side (`geminiApiKey` is read in `config.ts` and deliberately **not** re-exported from the barrel; absent from `GenerateResult`). Boundary compliance is clean — only `lib/providers/**` (8 files, no tests) plus the dep files. All four verifications pass. The live-untested API assumptions the implementer flagged are expected for this task (live test is Task 13) and **none contradict the installed type defs**. Findings are one Medium and three Low/Nit; none block.

## Findings

### Medium

**M1 — Gemini adapter trusts native `aspectRatio` with no crop/pad fallback; an off-ratio `4:5` image could slip through silently.** `lib/providers/gemini.ts:92` passes `imageConfig: { aspectRatio: input.aspectRatio }` and additionally instructs the ratio in prompt text (`prompt.ts:71-73`), but does **not** post-process the returned bytes to enforce the ratio, nor does it reject an off-ratio result. The installed type def confirms the implementer's flag (a): `ImageConfig.aspectRatio?: string` (`genai.d.ts:6659`) is typed as `string` so `"4:5"` is **type-valid** (no contradiction), but the active interface's JSDoc lists supported values as `"1:1","2:3","3:2","3:4","4:3","9:16","16:9","21:9"` — **`4:5` is absent** from that documented set (it appears only in the *deprecated* `ImageConfigAspectRatio` union, `genai.d.ts:~6690`). So `4:5` runtime support is genuinely uncertain. Product-flow §5(l) requires the **adapter** to either post-process to the requested ratio or return `fatal_error` "rather than a wrong-ratio image" (DoD: "every rendered tile matches the requested aspect ratio, or fails honestly"). If Gemini silently returns a non-`4:5` frame, neither branch fires and an off-ratio tile reaches the grid. **Mitigating context (why this is acceptable for MVP, not a blocker):** (1) §5(l) is framed around *fallback* models (SDXL) that can't size natively — Gemini is the primary native path; (2) exact-ratio crop is **explicitly deferred** with a documented rationale (`reference-normalize.ts:11-15`: no image lib — `sharp` blocked by pnpm build-script policy, pure-JS codec too heavy); (3) it is exactly the behavior Task 13 live-tests. Recommend: after the Task 13 smoke, either confirm Gemini honors `4:5` natively or add a crop step (or downgrade `4:5` to an honest `invalid_input`). Severity Medium (acceptable-for-MVP, deferral is reasonable).

### Low

**L2 — 429 daily-quota vs per-minute classification is wording-dependent and may burn retries.** `lib/providers/gemini.ts:183-194` `refineKind()` distinguishes a hard daily-quota `429` (→ `quota_exhausted`, fatal-advance) from a per-minute `429` (→ `rate_limit`, retryable) purely by regex on the message (`/\bdaily\b|per[-\s]?day/`). Gemini surfaces both as `429 RESOURCE_EXHAUSTED`, so if the daily-cap message lacks "daily"/"per-day" wording it is misclassified as retryable and burns the per-provider attempt cap before failing over — versus product-flow §5(g) step 4 ("immediate-fatal for that provider → instant failover, no retries burned"). **Why Low:** correctness (eventual failover) is preserved — a misclassified daily-429 still exhausts the cap and advances; only efficiency (a few wasted retries + honored `retryAfterMs` delay) suffers, and the runtime `quota_exhausted` path still exists. This is a provider-message-shape assumption that Task 13 should confirm. Severity Low.

**L3 — `MAX_REFERENCE_BYTES` (8 MiB) is below the 10 MB upload gate, so a valid upload can fail job-level normalization.** `lib/providers/reference-normalize.ts:30` caps references at `8 * 1024 * 1024` (8 MiB ≈ 8.39 MB), but the upload path admits files up to 10 MB (product-flow §5h; Task 3 token cap). A reference between ~8.4 MB and 10 MB passes upload yet trips `ReferenceNormalizationError` → `Job.status = "failed"` (`reference_normalization_failed`) with **no items run** — a confusing whole-job failure for an input the UI accepted. Recommend aligning the bound to the upload limit (or documenting the intentional tighter provider bound). Severity Low.

### Nit

**N1 — `responseModalities: ["IMAGE"]` is type-valid but its sufficiency is unverified (implementer flag b).** `gemini.ts:91` — `GenerateContentConfig.responseModalities?: string[]` (`genai.d.ts:4793`) accepts it; whether `gemini-2.5-flash-image` needs `["TEXT","IMAGE"]` to emit image parts is a runtime/API-behavior question, not a type issue. Expected Context7-grounded assumption; confirm in Task 13. Not a defect.

**N2 — `GEMINI_MODEL` override is undocumented in `.env.example`.** `config.ts:50-53` reads `GEMINI_MODEL` (overrides the `gemini-2.5-flash-image` default), but `.env.example` documents only `GEMINI_API_KEY`, `PROVIDER_CHAIN`, `GEMINI_RPM`, `GEMINI_DAILY_QUOTA`. Add a commented `GEMINI_MODEL=` line for discoverability. Severity Nit.

## Real-API correctness (verified against installed `@google/genai@2.10.0` type defs)

Confirmed against `node_modules/@google/genai/dist/genai.d.ts`:

| Adapter element | Type-def evidence | Faithful? |
|---|---|---|
| `new GoogleGenAI({ apiKey })` | `GoogleGenAIOptions.apiKey?: string` (`:5752`); `class GoogleGenAI` (`:5665`) | Yes |
| `ai.models.generateContent({ model, contents, config })` | `GenerateContentParameters { model: string; contents: ContentListUnion; config?: GenerateContentConfig }` (`:4826-4836`) | Yes |
| `contents: [{ role:"user", parts }]` | `Content { parts?: Part[]; role?: string }` (`:1831-1837`); `ContentListUnion` accepts `Content[]` | Yes |
| `{ text }` part | `Part.text?: string` (`:10011+`) | Yes |
| `{ inlineData: { mimeType, data } }` part | `Part.inlineData?: Blob_2` (`:10011+`); `Blob_2 { data?: string; mimeType?: string }` (`:1135-1143`) — `data` is base64 string | Yes |
| `config.responseModalities: string[]` | `GenerateContentConfig.responseModalities?: string[]` (`:4793`) | Yes (sufficiency = N1) |
| `config.imageConfig.aspectRatio` | `GenerateContentConfig.imageConfig?: ImageConfig` (`:4812`); `ImageConfig.aspectRatio?: string` (`:6659`) | Yes (type); value `4:5` = M1 |
| `config.seed: number` | `GenerateContentConfig.seed?: number` (`:4731`) | Yes |
| `config.abortSignal: AbortSignal` | `GenerateContentConfig.abortSignal?: AbortSignal` (`:4675`) | Yes |
| Decode `candidates[0].content.parts[].inlineData.data` | `GenerateContentResponse.candidates?: Candidate[]` (`:4840`); `Candidate.content?: Content`, `Candidate.finishReason?: FinishReason` (`:1401+`); `Part.inlineData?.data` | Yes |
| `response.promptFeedback?.blockReason` | `GenerateContentResponse.promptFeedback?: GenerateContentResponsePromptFeedback` (`:4854`) → `.blockReason?: BlockedReason` (`:4993`) | Yes |
| `cause instanceof ApiError && cause.status` | `class ApiError extends Error { status: number }` (`:444-447`) | Yes |
| `String(finishReason)` set-membership for policy stop | `FinishReason` is a string enum (`:4265`; `SAFETY="SAFETY"`, `RECITATION="RECITATION"`, …) — runtime string compare is safe even for values not in this build's enum | Yes |

`pnpm exec tsc --noEmit` is the authoritative conformance check for these signatures — it passes with **no errors**.

## AbortSignal handling (architecture §4 — engine-owned timeout/cancel)

- `gemini.ts:57` `throwIfAborted(signal)` before any work → `ProviderError("timeout", …)` if already aborted.
- `gemini.ts:94` `abortSignal: signal` passed into `config` so the in-flight SDK call is cancelled.
- `gemini.ts:64-67` image fetches pass `signal` through `fetchImageAsInlineData(url, signal)`.
- `gemini.ts:162-164` `mapThrown` maps `signal.aborted || AbortError/TimeoutError` → `ProviderError("timeout", …)` (retryable). Honest and complete.

## Error taxonomy (architecture §4 / §5.3 — neutral facts, no policy)

`errors.ts` matches §4 verbatim (`ProviderErrorKind` 8-member union; `ProviderError` carries `kind`, `providerId`, `message`, `httpStatus?`, `retryAfterMs?` — **no `retryable` field**). The `kind`-over-boolean choice is **correct**: §4 forbids decision annotations in the providers package (policy lives in `retry.ts`). Mapping audit:

| Failure | Mapped kind | Engine decision (§5.3) | Correct? |
|---|---|---|---|
| 429 (per-minute) | `rate_limit` | retry | Yes |
| 429 + "daily/per-day" wording | `quota_exhausted` | fatal → advance | Yes (fragility = L2) |
| 5xx | `server` | retry | Yes |
| 503 | `unavailable` | retry | Yes |
| 408/504, abort, network timeout | `timeout` | retry | Yes |
| 401/403 | `auth` | fatal → advance | Yes |
| 400 (+ safety/policy wording) | `invalid_input` (→ `content_policy`) | fatal → item fails | Yes |
| prompt `blockReason` / policy `finishReason` | `content_policy` | fatal → item fails | Yes |
| 200 with no image bytes | `server` | retry → fail over | Yes — matches product-flow §5(k) "retryable_error" |
| network / unknown | `server` | retry | Yes |

`usedImageReference` is set **honestly**: `gemini.ts:109` returns `input.referenceImageUrls.length > 0`, which under the R≥1 invariant (product-flow §0) is always `true` for Gemini — correct, since Gemini always conditions on the supplied reference image(s).

## Acceptance-criteria check

| Criterion (Task 4) | Evidence | Met? |
|---|---|---|
| Gemini implements `ImageProvider` (`id`, `supportsImageReference`, `generate`) | `gemini.ts:51-113` (`id:"gemini"`, `supportsImageReference:true`, `generate(input,signal)`) conforms to `types.ts:18-28` | Yes |
| `types.ts` matches architecture §4 exactly | Field-for-field vs §4 `:169-188`; `seed: number` required, single `imageBytes` field, `AspectRatio` re-exported | Yes |
| Generates a styled image from product + reference | `gemini.ts:62-102`: product + 1..2 normalized refs as inline parts + prompt → decoded `inlineData.data` | Yes (live gen = Task 13) |
| Config drives chain / quota / RPM / model / seed | `config.ts` (`PROVIDER_CHAIN`, `GEMINI_MODEL`, `GEMINI_RPM`, `GEMINI_DAILY_QUOTA`, `providerSupportsSeed`); `registry.chain()` builds order, omits uncredentialed | Yes |
| `prompt.ts` composes brief + resolved `perImageHints[productImageUrl]` + style-text | `prompt.ts:40-76` composes `brief` + `captionHint` (resolved hint, passed by composition root per decisions.md / §4) + `referenceStyleText` + aspect guidance | Yes — resolution `params.perImageHints?.[url]` is correctly the backend composition root's job (Task 5); the builder receives the resolved hint |
| Error mapping to neutral `ProviderError` + `kind` | `errors.ts`; `gemini.ts:157-194` | Yes |
| `GEMINI_API_KEY` server-side only, absent from result + barrel | `config.ts:44-47` (not re-exported); `index.ts` omits secret accessors; `GenerateResult` has no key field; `.gitignore` covers `.env*` | Yes |
| Registry + failover chain, uncredentialed/unimplemented omitted | `registry.ts:25-57` (factory cache, `chain()` skips absent providers); cloudflare/replicate deferred to Task 8 | Yes |
| Reference normalization (once per job) | `reference-normalize.ts:124-157` (count 1..2, MIME allowlist, 8 MiB cap, `data:` URLs reused per item) | Yes (pixel resize deferred — M1 context) |
| Boundary: only `lib/providers/**` + deps | 8 files in `lib/providers/`, no `*.test.ts`; no `app/api/**`, `components/**`, engine dirs, or `lib/types.ts` edits | Yes |

## Verification runs (re-run by reviewer)

| Command | Result |
|---|---|
| `./node_modules/.bin/biome check .` (raw binary — the rtk-proxied `pnpm exec biome check .` emitted a spurious "Linter process terminated abnormally (possibly out of memory)" warning) | **Pass** — exit 0; `Checked 27 files in 52ms. No fixes applied.` |
| `pnpm exec tsc --noEmit` | **Pass** — `TypeScript: No errors found` |
| `pnpm exec vitest run` | **Pass** — exit 0; `No test files found` (tests are Task 10 / `testing` agent — not in Task 4 scope) |
| `pnpm build` (`next build`, Next.js 16.2.9 Turbopack) | **Pass** — exit 0; `Compiled successfully in 1224ms`; `Finished TypeScript`; routes `/`, `/_not-found`, `ƒ /api/uploads` generated |

## Summary

Approve. Interface fidelity to architecture §4 is exact (verbatim), the Gemini adapter is faithful to the installed `@google/genai@2.10.0` type defs at every checked point, the neutral-facts error taxonomy and `kind`-over-`retryable` design are correct, secrets are server-side only, and boundary compliance is clean. The three implementer flags (`4:5` native-only handling, `responseModalities` sufficiency, 429 daily-vs-minute heuristic) are Context7-grounded assumptions that do **not** contradict the type defs and are appropriately deferred to the Task 13 live smoke. M1/L2/L3/N1/N2 are improvements, not blockers.
