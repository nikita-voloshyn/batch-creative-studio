# Review: Task 2 — Upload UI + validation + visual-language base

**Date:** 2026-06-26
**Plan:** `docs/plans/batch-creative-studio-mvp-plan.md` (Task 2)
**Dispatch:** `docs/plans/batch-creative-studio-mvp-dispatch.md` (Group 2)
**Implementer:** `frontend`
**Reviewer:** `reviewer` (fresh context)

---

## Verdict

**Approve with nits.**

Every acceptance criterion is met. A user can add, preview, and remove product (N≤20) and reference (1–2) images across two visually separated buckets; invalid files are rejected client-side with a precise, file-named reason (format → size → decode → resolution, in that order); aspect ratio, brief, and per-image hints are captured. The `POST /api/uploads` request/response contract and the `POST /api/jobs` body assembled by `buildCreateJobRequest` match architecture §7.2 field-for-field — `perImageHints` keyed by `productImageUrl` (the Blob URL), no `Item.captionHint`. The editorial/charcoal visual language matches README §10 / spec §5.2.1 (white `#ffffff`, charcoal `#1a1a1a`, hierarchy by weight/size, ALL-CAPS labels, thin `hr`, no shadowed cards). Boundaries are clean: nothing under `app/api/**`, `lib/providers/**`, `lib/orchestrator|state|blob/**`, or any `*.test.ts`; all client modules carry `"use client"`; no secrets or provider calls in the browser. The absent grid/SSE/Generate-submission is correct (Task 7). All verification commands exit 0 (Biome via the raw binary; the `rtk` wrapper's 254 is a known artifact). The only findings are a defense-in-depth gap in the readiness check and a narrow cross-call cap race, both downstream-guarded and non-blocking.

---

## Findings by severity

### Critical
None.

### High
None.

### Medium
None.

### Low

- **L1 — `isReadyToGenerate` does not enforce the product upper bound (N≤20), only the reference upper bound.**
  `lib/client/store.ts:118-124`. The check is `products >= 1 && references >= 1 && references <= MAX_REFERENCE_IMAGES` — the reference cap is verified but `products <= MAX_PRODUCT_IMAGES` is not. If product count ever exceeds 20, Generate stays enabled and `buildCreateJobRequest` (`store.ts:200-224`) would emit >20 `productImageUrls`, violating the architecture §7.2 `(1..20)` bound.
  *Scenario / mitigation:* `addFiles` (`store.ts:130-169`) caps additions at `MAX_PRODUCT_IMAGES`, so 21 products cannot normally be added, and Task 3/6 will re-validate counts server-side. The gap is purely the asymmetry that the reference bound is mirrored in the readiness gate but the product bound is not. Recommend mirroring it: add `products <= MAX_PRODUCT_IMAGES` to `isReadyToGenerate`. No user-visible defect today.

- **L2 — Cap enforcement can be exceeded by two concurrent `addFiles` calls (the async-validation window).**
  `lib/client/store.ts:134-148`. Each iteration reads the live count (`get().entries.filter(...)`) then `await validateImageFile(file)` before `set`. Within a single `addFiles` call this is correctly sequential (the code comment "sequential => no race" holds there). Across two **overlapping** calls it does not: two rapid drop events on the reference bucket can both read `count = 1`, both pass `1 >= 2 === false`, then both append → 3 references (one orphan-uploaded to Blob).
  *Scenario / mitigation:* requires a double-drop inside the validation window (image decode, ~ms). The downstream readiness gate (`references <= MAX_REFERENCE_IMAGES`, `store.ts:123`) disables Generate when breached and `buildCreateJobRequest` returns `null`, so an over-cap selection can never start a job — the failure mode is a confusing UI (3 thumbnails, Generate disabled, no "too many references" message) plus a leaked upload Blob (a leak already acknowledged for removed/abandoned uploads, product-flow §5t), not an invalid request. Severity is bounded to Low by that guard.

### Nit

- **N1 — Rejection list React key can collide on identical (name, reason) pairs.**
  `components/uploader/Uploader.tsx:66,102` use `key={`${r.name}-${r.reason}`}`. Two files with the same name rejected for the same reason in one add produce duplicate keys (React warning, possible render glitch). Cosmetic; thumbnails correctly key on the UUID `entry.id`.

- **N2 — `lib/client/fileValidation.ts` and `lib/client/uploadClient.ts` omit `"use client"`.**
  Correct and intentional — both are pure modules with no React/JSX/hooks and are imported only by client modules, so the directive is unnecessary. Noted only to confirm it was considered, not a defect.

### Positive notes (not defects)

- **Object-URL hygiene is correct.** `readImageDimensions` (`fileValidation.ts:56-71`) revokes its temporary probe URL on both `onload` and `onerror`; the persistent preview URL (`store.ts:158`) is revoked on `removeEntry` (`store.ts:171-175`) and `reset` (`store.ts:195-198`). No leak on the validate/preview/remove paths.
- **Validation order is correct and cheap-first:** format → size → decode-as-image → resolution bounds (`fileValidation.ts:77-103`), so the expensive async decode only runs after the synchronous format/size gates pass. The decode step (`Image` onerror → `null`) also catches disguised non-images.
- **Caps are off-by-one-correct:** DropZones disable at `length >= MAX_*` (`Uploader.tsx:60,98`) and `addFiles` rejects at `currentCount >= cap` (`store.ts:137`), both yielding exactly the cap (20 / 2), never cap+1, within a single call.
- **Contract fidelity is exact.** `uploadClient` posts `{ filename, contentType, kind }` and consumes `{ uploadUrl, blobUrl }` (`uploadClient.ts:79-104`); `buildCreateJobRequest` emits `{ productImageUrls, referenceImageUrls, params: { aspectRatio, brief?, perImageHints? } }` with `perImageHints` keyed by the product `blobUrl` and `brief`/`perImageHints` omitted when empty (`store.ts:200-224`).
- **Eager upload + readiness gate** match product-flow §2.4/§2.6: files upload on add, and Generate is enabled only when every entry is `uploaded` with a `blobUrl` (`store.ts:118-124`), so the submitted payload is always URLs, never in-flight files.

---

## Acceptance-criteria check

| Criterion (plan Task 2) | Result | Evidence |
|---|---|---|
| User selects product images (N≤20) | ✅ Pass | Product `DropZone` + picker, cap 20 (`Uploader.tsx:56-62`, `store.ts:131-146`, `fileValidation.ts:36`) |
| User selects reference images (1–2) | ✅ Pass | Separate reference bucket, cap 2, disabled at 2 (`Uploader.tsx:94-100`, `MAX_REFERENCE_IMAGES`) |
| Previews each file | ✅ Pass | `FilePreview` renders object-URL thumbnail + status (`FilePreview.tsx:26-43`) |
| Removes each file | ✅ Pass | `× ` button → `removeEntry`, revokes object URL (`FilePreview.tsx:30-37`, `store.ts:171-175`) |
| Invalid files rejected client-side, clear reason | ✅ Pass | Format/size/decode/resolution with file-named messages (`fileValidation.ts:77-103`), shown inline (`Uploader.tsx:63-71,101-109`) |
| Params captured (aspectRatio / brief / perImageHints) | ✅ Pass | `ParamsForm` segmented ratio, brief textarea, per-image hint rows (`ParamsForm.tsx:38-93`); assembled in `buildCreateJobRequest` (`store.ts:200-224`) |
| Direct-to-Blob upload wired to `/api/uploads` contract | ✅ Pass | `uploadClient.uploadFile` sign → PUT (`uploadClient.ts:79-104`) |
| Visual language matches §5.2.1 / README §10 | ✅ Pass | `globals.css` tokens + base styles (see table below) |

### Contract-fidelity detail (architecture §7.2 / decisions.md 2026-06-26)

| Contract element | Spec | Implementation | Match |
|---|---|---|---|
| `POST /api/uploads` request | `{ filename, contentType, kind }` | `SignedUploadRequest` (`uploadClient.ts:27-31,85-88`) | ✅ exact |
| `POST /api/uploads` response | `{ uploadUrl, blobUrl }` | `SignedUploadResponse` (`uploadClient.ts:34-37,85`) | ✅ exact |
| No client-declared size in request | size only at signed token | request body carries no size field (`uploadClient.ts:85-88`) | ✅ correct |
| `POST /api/jobs` body | `{ productImageUrls, referenceImageUrls, params }` | `CreateJobRequest` (`store.ts:61-69,223`) | ✅ exact |
| `params` shape | `{ aspectRatio; brief?; perImageHints? }` | `store.ts:62-68,218-222` | ✅ exact (brief/hints omitted when empty) |
| `perImageHints` keyed by `productImageUrl` | keyed by product Blob URL | `perImageHints[e.blobUrl] = hint` (`store.ts:206-211`) | ✅ correct |
| No `Item.captionHint` | hint lives on `Job.params` | hints held on `UploadEntry.hint`, folded into `perImageHints` only (`store.ts:44,181-185,206-211`) | ✅ correct |
| `AspectRatio` source | canonical `lib/types.ts` | imported from `@/lib/types` (`ParamsForm.tsx:5`, `store.ts:20`) | ✅ correct |

### Visual-language fidelity (README §10 / spec §5.2.1)

| Requirement | Result | Evidence (`app/globals.css`) |
|---|---|---|
| White `#FFFFFF` background | ✅ | `--color-bg: #ffffff` applied to `body` (`:17,71`) |
| Charcoal `~#1A1A1A` text | ✅ | `--color-ink: #1a1a1a` on `body` (`:18,72`) |
| Hierarchy by weight/size, not color | ✅ | `--text-display/heading/body/small/label` + weight tokens (`:34-42`); single ink color for text |
| ALL-CAPS small labels | ✅ | `.label`/`.field__label`/`.status` `text-transform: uppercase` + `--label-tracking` (`:150-157,205-211,181-186`) |
| Thin `hr`, no shadowed cards | ✅ | `hr` = 1px top border (`:104-108`); no `box-shadow` anywhere; fields are flat `1px` borders, `border-radius: 0` |
| Generous whitespace, max-width column | ✅ | `--content-max: 980px`, `.content` padding `space-12` (`:46,111-115`) |
| Muted, functional status accents only | ✅ | success/error reserved to `.status--uploaded/--error` (`:191-196`) |
| Image as hero / restrained tiles | ✅ | `.thumb__frame` flat field bg + `object-fit: cover` (`:347-358`) |
| Responsive baseline (NFR-7) | ✅ | `@media (max-width:640px)` reflows scale, padding, thumb grid (`:450-460`); `.thumbs` `auto-fill minmax` (`:336-340`) |

### Boundary compliance

| Rule | Result | Evidence |
|---|---|---|
| No `app/api/**` | ✅ | `app/` = `globals.css`, `layout.tsx`, `page.tsx` only |
| No `lib/providers/**` | ✅ | absent |
| No `lib/orchestrator|state|blob/**` | ✅ | absent |
| No `*.test.ts` / `test/**` | ✅ | none found |
| Client Components carry `"use client"` | ✅ | `StudioShell`, `Uploader`, `DropZone`, `FilePreview`, `ParamsForm`, `store.ts` all declare it |
| No secrets / provider calls in browser | ✅ | `uploadClient` hits same-origin `/api/uploads` + signed PUT only; no keys read |
| Grid / SSE / Generate submission absent (Task 7) | ✅ correct | `StudioShell.onGenerate` is a documented typed no-op stub (`StudioShell.tsx:25-31`) |
| Files in scope only | ✅ | exactly the 12 Task-2 files + `package.json` (zustand added) |

---

## Verification runs

| Command | Exit | Key output |
|---|---|---|
| `pnpm exec biome check .` (rtk wrapper) | 254* | `[warn] Linter process terminated abnormally (possibly out of memory)` — wrapper artifact |
| `./node_modules/.bin/biome check .` (raw) | 0 | `Checked 18 files in 34ms. No fixes applied.` |
| `pnpm exec tsc --noEmit` | 0 | `TypeScript: No errors found` |
| `pnpm build` | 0 | `✓ Compiled successfully`; TypeScript step finished; `✓ Generating static pages 3/3`; routes `/` + `/_not-found` static |

\* **Note on Biome:** the `rtk` command-rewriting wrapper printed exit 254 with an OOM-style warning. Running the **same** Biome binary directly (`./node_modules/.bin/biome check .`) returned exit 0, `Checked 18 files … No fixes applied.` The 254 is a wrapper/output-piping artifact, not a real Biome failure — Biome passes clean. (Matches the same artifact noted in the Task 1 review.)
