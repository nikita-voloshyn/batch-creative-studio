# Review: Task 3 — Upload endpoint `POST /api/uploads`

- **Date:** 2026-06-26
- **Implementer:** backend
- **Reviewer:** reviewer (fresh context)
- **Plan / Dispatch:** `batch-creative-studio-mvp-plan.md` (Task 3) · `batch-creative-studio-mvp-dispatch.md` (Group 2)
- **Scope reviewed:** `app/api/uploads/route.ts`, `package.json` / `pnpm-lock.yaml` (`@vercel/blob@2.5.0`), `docs/state/open-questions.md` (divergence note). Read-only; no source edited.

## Verdict

**Approve (LGTM).** The route implements the **real** `@vercel/blob` v2.5.0 client-upload mechanism (`handleUpload()` + `onBeforeGenerateToken`) faithfully and securely: the content-type allowlist and 10 MB cap are baked **authoritatively into the minted token** (enforced at Blob, not advisory), `kind ∈ {product, reference}` is validated, `pathname` is constrained to `uploads/{kind}/…`, the `BLOB_READ_WRITE_TOKEN` secret never leaves the server, missing-token → 500, and validation failures → 400. The upload-contract divergence from architecture §7.2 (`{uploadUrl, blobUrl}`) is **real and was handled correctly** — the backend implemented the real API and recorded a precise, actionable frontend follow-up in `open-questions.md` rather than editing the frontend's `lib/client/uploadClient.ts`. Boundary compliance is clean. All verification commands pass. Findings are limited to one Low and two Nits; none block.

## Findings

### Low

**L1 — Internal token-mint / SDK errors are surfaced as `400`, not `5xx`.** `app/api/uploads/route.ts:142-148` — The outer `catch` returns **400** for *every* error thrown inside `handleUpload()`. That is correct for `onBeforeGenerateToken` validation failures (bad `kind` / `pathname` / `clientPayload`), but it also swallows genuine server-side failures (e.g. the Blob token-mint HTTP call failing, or an `upload-completed` callback-signature verification error) into a client-facing `400 Bad Request`. The route comment (`:143-145`) even acknowledges "validation failures … **and token-mint errors** land here." A Blob-side outage would therefore look like a client mistake. Acceptable for MVP (no security impact, no info leak), but ideally distinguish: keep `400` for `onBeforeGenerateToken`-thrown validation errors and return `500` for token-mint/transport failures. Severity Low.

### Nit

**N1 — Divergence-note wording is slightly overstated (not a defect).** `app/api/uploads/route.ts:13-16` and `docs/state/open-questions.md` (T3 bullet) both state "**there is NO presigned-`PUT`-URL flow**." Strictly, v2.5.0 *does* export a presigned path (`uploadPresigned()` / `handleUploadPresigned()` / `GeneratePresignedUrlEvent`, see `node_modules/@vercel/blob/dist/client.d.ts:198-323`). The **substantive** claim is nonetheless correct and load-bearing: the architecture §7.2 idealized contract — a hand-rolled route returning `{ uploadUrl, blobUrl }` answered by a manual client `PUT` — genuinely does not exist; even the presigned path is driven by the `uploadPresigned()` SDK helper over the `blob.generate-presigned-url` event protocol, not a bespoke `{uploadUrl,blobUrl}` JSON response. Choosing `handleUpload()` (the standard, documented client-upload path) is the right call. Only the absolute phrasing "no presigned flow" is imprecise; the decision and the route are correct. **Per review scope, the divergence itself is treated as expected and correctly handled — not a defect.**

**N2 — `pathname` guard checks the prefix only.** `app/api/uploads/route.ts:122-125` validates `pathname.startsWith("uploads/${kind}/")` but does not inspect the remainder (e.g. `..` segments or an embedded second `uploads/{otherkind}/`). This is **not exploitable**: Vercel Blob pathnames are flat object keys, not filesystem paths, so `../` cannot traverse out of the bucket; the result namespace (`results/…`) is separate, and `addRandomSuffix:true` guarantees per-object uniqueness. The prefix guard is the correct primary control. Noted for completeness only. Severity Nit.

## Real-API correctness (verified against installed v2.5.0 type defs)

Confirmed against `node_modules/@vercel/blob/dist/client.d.ts`:

| Route element | Type-def evidence | Faithful? |
|---|---|---|
| `handleUpload({ body, request, onBeforeGenerateToken, onUploadCompleted })` | `HandleUploadOptions` `client.d.ts:330-366`; helper `client.d.ts:367-379` | Yes |
| `body: HandleUploadBody` from `request.json()` | `type HandleUploadBody = GenerateClientTokenEvent \| UploadCompletedEvent` `:319` | Yes |
| `onBeforeGenerateToken(pathname, clientPayload, multipart)` returns `{ allowedContentTypes, maximumSizeInBytes, addRandomSuffix, tokenPayload }` | `:346-349` — return is `Pick<GenerateClientTokenOptions,'allowedContentTypes'\|'maximumSizeInBytes'\|'validUntil'\|'addRandomSuffix'\|'allowOverwrite'\|'cacheControlMaxAge'\|'ifMatch'> & { tokenPayload?; callbackUrl? }`. All four fields the route returns are valid members. | Yes |
| `onUploadCompleted` no-op | optional `:356`; route supplies an async no-op | Yes |
| Server-only token (defaults to `process.env.BLOB_READ_WRITE_TOKEN`) | `token?` `:357-361` | Yes |

`pnpm exec tsc --noEmit` is the authoritative check that the route conforms to these signatures — it passes with no errors.

## Security (architecture §9 / plan Risks)

- **Server-only secret.** `BLOB_READ_WRITE_TOKEN` is read only at `route.ts:102` (presence guard) and otherwise consumed inside the SDK default; never serialized into the response, never `NEXT_PUBLIC_*`. Pass.
- **Missing token → 500.** `route.ts:102-107`. Pass.
- **Validation failures → 400.** Bad JSON body `:110-114`; bad/missing `kind`, bad `clientPayload`, bad `pathname` all throw inside `onBeforeGenerateToken` and are caught → `:142-148`. Pass (see L1 for the over-broad 400).
- **Authoritative limits.** `allowedContentTypes = [png, jpeg, webp]` and `maximumSizeInBytes = 10 MB` are baked into the token (`:126-132`), so Blob rejects wrong-type / oversize uploads at the storage layer — not advisory. Pass.
- **`clientPayload` injection.** Parsed with `JSON.parse` in a `try/catch` (`:88-92`); only the `kind` field is read and is checked against a literal allowlist (`isUploadKind`, `:78-80`). No `eval`, no reflection. Pass.
- **`pathname` injection.** Bound to `uploads/${kind}/` (`:122-125`); `kind` and `pathname` are cross-tied (the prefix is derived from the validated `kind`), preventing a `kind=product` token writing under `uploads/reference/`. See N2 — prefix-only, but not exploitable on flat Blob keys. Pass.
- **SSRF.** This route only **mints tokens**; it performs no outbound fetch of user-supplied or provider URLs. The outbound-fetch SSRF surface is Task 6 (`POST /api/jobs`) + Task 12 (security review) and is out of scope here. No SSRF surface introduced by T3.

## Divergence handling (expected — confirmed correct)

- The backend did **not** edit `lib/client/uploadClient.ts` (frontend's domain). Confirmed: that file still declares `SignedUploadResponse { uploadUrl, blobUrl }` and the `"sign" | "put"` `UploadError` steps (`uploadClient.ts:33-49, 79-105`) — i.e. untouched.
- The `open-questions.md` follow-up note is **accurate and actionable**: it gives the exact `upload()` call the frontend must adopt (`upload(\`uploads/${kind}/${file.name}\`, file, { access: "public", handleUploadUrl: "/api/uploads", contentType: file.type, clientPayload: JSON.stringify({ kind }) })`) and restates the three constraints the route enforces (pathname prefix, `clientPayload` JSON `{ kind }`, content-type/size baked into the token).
- The divergence is **real**: the `{ uploadUrl, blobUrl }` single-response-plus-manual-`PUT` contract does not exist in `@vercel/blob`; `handleUpload` (token exchange) is the standard path. Backend made the right call. (Wording nit N1 aside.)

## Acceptance-criteria check

Restated acceptance (reviewer scope): *"Returns the signed-upload handshake; rejects wrong type/oversize; client uploads directly to Blob; server-only token."*

| Criterion | Status | Evidence |
|---|---|---|
| Returns the signed-upload handshake | **Met (via real API)** | Returns the `handleUpload()` JSON (client-token result) at `route.ts:141`. The original plan wording `{ uploadUrl, blobUrl }` is the idealized contract that does not exist; the real handshake is delivered — documented divergence. |
| Rejects wrong content-type | **Met** | `allowedContentTypes` baked into token `:127`; Blob rejects on violation. |
| Rejects oversize (>10 MB) | **Met** | `maximumSizeInBytes = 10*1024*1024` baked into token `:128`. |
| `kind ∈ {product, reference}` validated | **Met** | `parseKind` + `isUploadKind` `:78-98`. |
| `pathname` constrained to `uploads/{kind}/…` | **Met** | `:122-125`. |
| Client uploads directly to Blob | **Met (server-side enabled)** | Token minted server-side; bytes go browser→Blob via the client `upload()` helper (frontend follow-up pending). No bytes traverse the function. |
| Server-only token | **Met** | `BLOB_READ_WRITE_TOKEN` server-side only; 500 if absent `:102-107`. |

## Boundary compliance

Only `app/api/**` (the route), dependency files, and the `open-questions.md` note changed.

- `find app/api -type f` → only `app/api/uploads/route.ts`. No other route added.
- `lib/client/uploadClient.ts` unchanged (still old contract) — backend stayed out of the frontend's file.
- No `components/**`, `lib/providers/**`, `lib/orchestrator/**`, or `*.test.ts` touched by T3.
- `@vercel/blob@2.5.0` present in `package.json` and `pnpm-lock.yaml`.

Pass.

## Verification runs

| Command | Result |
|---|---|
| `node_modules/@biomejs/biome/bin/biome check .` (raw binary) | **Pass** — `Checked 19 files in 37ms. No fixes applied.` `RAW_EXIT=0`. (Note: via the rtk proxy `pnpm exec biome check .` falsely reported "Linter process terminated abnormally (possibly out of memory)"; the raw binary is authoritative and clean.) |
| `pnpm exec tsc --noEmit` | **Pass** — `TypeScript: No errors found`. |
| `pnpm exec vitest run` | **Pass** — 0 test files / 0 failures (test suites are Task 10, still Pending). |
| `pnpm build` (`next build`, Turbopack) | **Pass** — `✓ Compiled successfully`; route table shows `ƒ /api/uploads` = **Dynamic (server-rendered on demand)**, confirming the `force-dynamic` route is a dynamic function (not statically cached). |
