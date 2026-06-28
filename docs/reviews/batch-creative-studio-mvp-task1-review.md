# Review: Task 1 — Scaffold & toolchain + shared types

**Date:** 2026-06-26
**Plan:** `docs/plans/batch-creative-studio-mvp-plan.md` (Task 1)
**Dispatch:** `docs/plans/batch-creative-studio-mvp-dispatch.md` (Group 1)
**Implementer:** `backend`
**Reviewer:** `reviewer` (fresh context)

---

## Verdict

**Approve with nits.**

`lib/types.ts` reproduces the architecture §7 entity contract and the product-flow §8 SSE event contract **exactly** — every status/outcome union, the `Job.params` shape, the absence of `Item.captionHint`, and all five SSE payload types match field-for-field with no name drift and no invented fields. All four verification commands exit 0. Boundaries are respected: nothing was written under `components/**`, `lib/providers/**`, or any `*.test.ts`. The only items worth noting are informational (a developer-created `.env.local` holding live secrets — correctly gitignored, not a Task 1 deliverable — and a minor next.config/Fluid-Compute scope nuance). None block the task.

---

## Findings by severity

### Critical
None.

### High
None.

### Medium
None.

### Low

- **L1 — Live provider secrets sit in plaintext in `.env.local` on disk.**
  `/.env.local:12,17,20` contain a real `GEMINI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`.
  *Scenario / mitigation:* `.gitignore:16-18` (`.env`, `.env.*`, `!.env.example`) correctly excludes `.env.local`, and `git status` does not track it, so there is **no git-leak risk** — these will not be committed. The file is also **not** a Task 1 deliverable (the dispatch lists only `.env.example`); it was created out-of-band for local runs. The note stands only because the keys are live: if `.env.local` is ever shared/screen-captured, those credentials are usable. Recommend rotating the Gemini key + Cloudflare token before any public deploy/demo and keeping the file out of any archive/zip. No source change required.

### Nit

- **N1 — `next.config.ts` is empty `{}`; the plan row names "next.config (Fluid Compute)" as a T1 deliverable.**
  `/next.config.ts:14`. The file is a deliberate minimal scaffold (documented in its own JSDoc) that defers `maxDuration`/runtime tuning to later backend tasks. This is defensible: Fluid Compute is a Vercel **project setting** and `maxDuration` is a per-route export (`app/api/jobs/[id]/stream/route.ts`, arrives in T6), not a `next.config` field — so an empty config is correct for the scaffold. Not an acceptance-criteria item. Flagged only for traceability against the plan wording.

- **N2 — `vercel.json` (architecture §12, BE-owned: fluid/runtime, `maxDuration`) is not present.**
  Out of scope for T1's acceptance criteria; runtime/`maxDuration` is configured per-route in later tasks. Informational only.

### Positive notes (not defects)

- The named aliases `JobStatus` / `ItemStatus` / `AttemptOutcome` (`lib/types.ts:34,37,40`) extract architecture §7.1's inlined string unions into shared names. The string literals are **identical**, so the wire contract is unchanged; the file header documents this explicitly. These give the SSE payload types a shared referent and improve type safety without drift.
- `SseEventName` and `SseEventMap` (`lib/types.ts:144,156`) are helper types not literally in the §7.1 snippet, but they only enumerate the already-defined event names and map them to the already-defined payloads — no new wire field is invented. Useful for the T6 server / T7 client to share one typed contract.
- `app/layout.tsx` and `app/page.tsx` are genuine minimal placeholders, each carrying an explicit `SCAFFOLD STUB … do NOT build UI here … owned by frontend from Task 2` comment — exactly the boundary the dispatch Notes (§"Scaffold ownership") prescribe.

---

## Acceptance-criteria check

| Criterion (plan Task 1) | Result | Evidence |
|---|---|---|
| `pnpm install` green | ✅ Pass | exit 0 |
| `pnpm build` green | ✅ Pass | `next build` exit 0; "Compiled successfully", TypeScript step finished, 3/3 static pages |
| `pnpm exec vitest run` green | ✅ Pass | exit 0 (`passWithNoTests` — 0 tests, by design; suite arrives T10) |
| `lib/types.ts` exports the entity + event contract from architecture §7 | ✅ Pass | `Job`/`Item`/`Attempt`/`AspectRatio` + 5 SSE payloads, all field-exact |
| `lib/types.ts` compiles | ✅ Pass | `tsc --noEmit` exit 0, "No errors found" |

### Contract-fidelity detail (architecture §7.1 / product-flow §0,§8)

| Contract element | Spec | `lib/types.ts` | Match |
|---|---|---|---|
| `AspectRatio` | `"1:1" \| "4:5" \| "9:16"` | line 23 | ✅ exact |
| `JobStatus` | `running \| completed \| completed_with_errors \| failed` | line 34 | ✅ exact |
| `ItemStatus` | `queued \| running \| succeeded \| failed` | line 37 | ✅ exact |
| `AttemptOutcome` | `success \| retryable_error \| fatal_error` | line 40 | ✅ exact |
| `Job.params` | `{ aspectRatio; brief?; perImageHints? }` | lines 53-58 | ✅ exact |
| `Job` fields | `id, status, seed, params, referenceImageUrls, items, createdAt` | lines 48-63 | ✅ exact (incl. `seed: number`) |
| **No `Item.captionHint`** | hints live on `Job.params.perImageHints` | Item lines 66-82 — absent | ✅ correct |
| `Item.result` | `{ imageUrl; providerId; usedImageReference }` | lines 72-76 | ✅ exact |
| `Item.error` | `{ code; message; lastProviderId }` | lines 77-81 | ✅ exact |
| `Attempt` | `providerId, startedAt, finishedAt?, outcome, errorMessage?` | lines 85-93 | ✅ exact |
| `item.status` payload | `{ itemId, status }` | `ItemStatusEvent` 105-108 | ✅ exact |
| `item.result` payload | `{ itemId, imageUrl, providerId, usedImageReference }` | `ItemResultEvent` 111-116 | ✅ exact |
| `item.error` payload | `{ itemId, code, message, lastProviderId }` | `ItemErrorEvent` 119-124 | ✅ exact |
| `job.progress` payload | `{ done, failed, total }` | `JobProgressEvent` 127-131 | ✅ exact |
| `job.done` payload | `{ status }` | `JobDoneEvent` 139-141 | ✅ exact |
| SSE event names | `item.status / item.result / item.error / job.progress / job.done` | `SseEventName` 144-149 | ✅ exact |

### Boundary compliance

| Rule | Result | Evidence |
|---|---|---|
| No `components/**` | ✅ | directory absent |
| No `lib/providers/**` | ✅ | directory absent |
| No `*.test.ts` / `test/**` | ✅ | none found |
| `app/layout.tsx` + `app/page.tsx` minimal placeholder (allowed by dispatch Notes) | ✅ | both are labeled scaffold stubs, no real UI |
| Files in scope only | ✅ | tree = config files + `app/{layout,page}.tsx` + `lib/types.ts` |

---

## Verification runs

| Command | Exit | Key output |
|---|---|---|
| `pnpm install` | 0 | ok |
| `pnpm exec biome check .` | 0 | `Checked 9 files … No fixes applied.` |
| `pnpm exec tsc --noEmit` | 0 | `No errors found` |
| `pnpm exec vitest run` | 0 | 0 tests (`passWithNoTests: true`, by design) |
| `pnpm build` | 0 | `Compiled successfully`; TypeScript step finished; static pages 3/3 |

**Note on Biome run:** the first `pnpm exec biome check .` through the developer's `rtk` command-rewriting wrapper printed `[warn] Linter process terminated abnormally (possibly out of memory)` with exit 254. Re-running the **same** Biome binary raw (`rtk proxy ./node_modules/.bin/biome check .`) returned `Checked 9 files … No fixes applied.` with exit 0. The 254 is a wrapper/output-piping artifact, **not** a real Biome failure — Biome passes clean.
