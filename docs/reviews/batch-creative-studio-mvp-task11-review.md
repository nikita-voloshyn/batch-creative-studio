# Task 11 Review — Export (single + zip) + status labels/badges

**Date:** 2026-06-28
**Implementer:** frontend
**Reviewer:** reviewer (fresh context)
**Task:** 11 — Export (single full-res download + whole-batch zip) + ALL-CAPS status labels / prompt-only badge / final visual-language pass
**Acceptance (plan):** "Download single post + zip works; labels/badges per visual language."

---

## Verdict

**Request changes (minor).** The implementation is functionally correct and acceptance-complete: the single-post download uses the correct cross-origin `fetch → blob → object-URL → <a download> → revoke` pattern, the zip path includes only succeeded items with a `MANIFEST.txt`, object URLs are revoked (no leak), the CORS dependency is correctly flagged for Task 13 with no server route added, and labels/badges follow the editorial visual language with no regression of Task 7's `StatusBadge`. Boundary compliance is clean. **However `pnpm exec biome check .` is RED** — one auto-fixable formatting violation in `lib/client/export.ts:88` — so the Task 11 `/check` post-skill gate is failing. Fix that one line (`biome check --write`) and this is a clean Approve.

---

## Findings by severity

### Medium

**M1 — `biome check .` fails the format gate (`lib/client/export.ts:88`).**
The `fetchImageBytes` return statement is a single long line that Biome wants wrapped:
```ts
return { bytes: new Uint8Array(buffer), ext: extFromContentType(res.headers.get("content-type"), url) };
```
Biome reports: *"Formatter would have printed the following content"* (multi-line object literal). `pnpm exec biome check .` exits non-zero (1 error, 68 files checked). This is purely cosmetic and auto-fixable, but the project's `/check` post-skill (dispatch Group 6) and CLAUDE.md rule 5 ("Test before committing") require a green lint/format gate. **Required fix:** run `pnpm exec biome check --write lib/client/export.ts` (or format the return as a multi-line object). No other file is affected.

### Low

**L2 — Mid-batch zip manifest wording can misdescribe in-progress items (`lib/client/zip.ts:61-63`).**
When the user zips while the batch is still streaming (the control is intentionally available progressively), the omitted line reads `Omitted: N item(s) did not succeed and were skipped.` — but some of those N may still be `queued`/`generating`, not failed. The header line ("Failed or unfinished items are omitted") is accurate; only the trailing summary overstates. Suggest "did not succeed (failed or not yet finished)". Cosmetic; does not affect the archive contents.

### Nit

**N3 — Prompt-only badge text uses a middot vs the spec's colon (`components/grid/ResultTile.tsx:70`).**
Rendered (after CSS uppercase) as `STYLE · PROMPT-ONLY`; product-flow §5c writes it `STYLE: PROMPT-ONLY`. Purely typographic; consistent with the editorial register either way.

**N4 — `extFromContentType` source differs slightly between the two fetch helpers (`lib/client/export.ts:78` vs `:88`).**
`fetchImageBlob` prefers `blob.type || header`; `fetchImageBytes` uses only the response header. Correct in both cases (an `ArrayBuffer` carries no type, so the header is the right source for the zip path) — noting only the asymmetry.

---

## Acceptance-criteria check

| Criterion | Status | Evidence |
|---|---|---|
| Single full-res download works cross-origin | PASS | `export.ts:95-117` — `fetchOk` → `res.blob()` → `saveBlob` (object URL + `<a download>` click + deferred `revokeObjectURL`); does NOT rely on a bare cross-origin `<a download href>` |
| Single-download filename/ext sane | PASS | `post-{index+1}.{ext}`; ext from `blob.type`→header→URL-path→`png` fallback (`export.ts:44-56, 114-117`) |
| Single-download error/retry state | PASS | `DownloadPostButton.tsx` idle/working/error; "Retry download" on failure, `aria-busy` while working |
| Zip includes only `status==="done"` + `result.imageUrl` | PASS | `DownloadAllButton.tsx:21-30` filters on both |
| Each image fetched → bytes → packed with `fflate` | PASS | `zip.ts:87-99` `Promise.all(fetchImageBytes)` → `zipSync`, images `STORE` (`level:0`), manifest deflated |
| `MANIFEST.txt` lists posts + only-succeeded/omitted counts | PASS | `zip.ts:41-66, 106-108` ("Included posts: X of Y", per-post rows, omitted count) |
| Zip filename `batch-{jobId}.zip` | PASS | `zip.ts:112` (`batch.zip` only if jobId absent) |
| Control disabled until ≥1 succeeded; shows live count | PASS | `DownloadAllButton.tsx:33,46-51` (`disabled = count===0||working`; "Download all · N posts") |
| No crash on 0 succeeded | PASS | Button disabled at 0; `downloadBatchZip` also throws a guarded `ExportError` (`zip.ts:81-83`) |
| Object-URL leak (revoke) | PASS | `saveBlob` revokes after 1s for both single and zip (`export.ts:106`) |
| CORS flagged for Task 13; no server route | PASS | Header comments in `export.ts:11-14` / `zip.ts:14-17`; footprint touches no `app/api/**` |
| ALL-CAPS status labels (QUEUED/GENERATING/FAILED) | PASS | `StatusBadge.tsx` + `.status { text-transform:uppercase }` (`globals.css:181-207`) |
| Prompt-only badge on `usedImageReference===false` | PASS | `ResultTile.tsx:64-71` + `.badge--prompt-only` (`globals.css:510-526`) |
| No Task 7 `StatusBadge` regression/duplication | PASS | `StatusBadge.tsx` untouched by Task 11 (mtime 11:43, outside the 15:32+ batch); not re-implemented |
| Boundary: only `lib/client/**`, `components/**`, `app/globals.css`, `package.json`(+lock) | PASS | Task 11 footprint = export.ts, zip.ts, DownloadPostButton, DownloadAllButton, ResultTile, BatchGrid, globals.css; no `app/api/**`, `lib/providers/**`, backend `lib/{orchestrator,state,blob,ratelimit}/**`, no `*.test.ts` |
| `fflate` added (no jszip) | PASS | `package.json:19` `fflate@^0.8.2`; lockfile resolves 0.8.3 |

---

## Verification runs

| Command | Result |
|---|---|
| `pnpm exec biome check .` | **FAIL** — 1 format error (`lib/client/export.ts:88`), 68 files checked. (Run as the raw `./node_modules/.bin/biome` binary; the rtk proxy falsely reported OOM.) |
| `pnpm exec tsc --noEmit` | **PASS** — "No errors found" |
| `pnpm exec vitest run` | **PASS** — 106 passed / 0 failed |
| `pnpm build` | **PASS** — Next.js 16.2.9, compiled successfully; routes generated (5 dynamic API routes + `/`) |

---

## Notes

- **Async-race / memory review (zip):** `Promise.all` over ≤20 fetches; a single failure rejects the whole export and surfaces as a retryable "Zip failed — retry" — no partial/corrupt archive. `zipSync` holds all bytes in memory, bounded by N≤20 — no blowup concern for MVP bounds. Index space is shared between single (`ResultTile` grid index) and zip (`forEach` index), so `post-{n}` filenames line up across both export paths.
- **Null-path safety:** `DownloadPostButton` renders only on `isDone && item.result`; `DownloadAllButton` guards on `item.result?.imageUrl` — no missing-URL crash.
- **No backend route added** — both export paths fetch Vercel Blob directly from the browser; the CORS requirement is correctly documented as a Task 13 deploy concern, consistent with product-flow §5m and architecture §2 (C6).
- Architecture §12's indicative `PromptOnlyBadge.tsx` is inlined into `ResultTile` rather than a separate component — acceptable deviation (the §12 file list is indicative, not contractual); no duplication results.
