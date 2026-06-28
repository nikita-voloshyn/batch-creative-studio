---
component: uploadClient
source: lib/client/uploadClient.ts
agent: frontend
updated: 2026-06-28
---

# uploadClient

## Purpose
Uploads a validated image directly to Vercel Blob from the browser using `@vercel/blob/client`'s `upload()` helper, returning the durable `blobUrl`. Keeps the Blob write token server-side — the browser only ever holds a short-lived scoped client token minted per upload.

## Public Interface
- `uploadFile(file, kind, signal?) → Promise<string>` — uploads one file, resolves to its durable `result.url`.
- `class UploadError extends Error` — `{ status? }`; surfaced to the uploader UI for per-file reason/retry.
- Types: `UploadKind = "product" | "reference"`, `UploadContentType = "image/png" | "image/jpeg" | "image/webp"`.

## Inputs and Outputs
- `uploadFile`: calls `upload(`uploads/${kind}/${file.name}`, file, { access: "public", handleUploadUrl: "/api/uploads", contentType, clientPayload: JSON.stringify({ kind }), abortSignal })`. Returns `result.url`. Any failure (token mint rejected, network, Blob PUT rejection) is caught and rethrown as `UploadError` with the underlying message.
- Reads no secrets. The pathname namespace and `clientPayload` are exactly what the server route (`app/api/uploads/route.ts`) requires to mint the token.

## Dependencies
- `@vercel/blob/client` — `upload()` two-phase token-exchange helper.
- `app/api/uploads/route.ts` (runtime contract, not an import) — server `handleUpload` that mints the token and enforces the path/kind/content-type/size rules.

## Key Decisions
- Uses the real `@vercel/blob` v2.5.0 two-phase client-upload flow (Context7-verified), not the idealized presigned-`PUT` `{ uploadUrl, blobUrl }` flow sketched in architecture §7.2 — that flow does not exist in the SDK. This was the cross-task fix from `docs/state/open-questions.md` (2026-06-26).
- The server bakes the content-type allowlist + 10 MB cap authoritatively into the minted token; the request carries no client-declared size.
- Pathname must start with `uploads/${kind}/` and `clientPayload` must be `{ kind }` with `kind ∈ {product, reference}` — the server's path-namespace and payload guards.

## Known Limitations
- Trusts the caller to validate the file first (`file.type` cast to `UploadContentType`); does no validation itself.
- `UploadError.status` is declared but not populated here (the helper does not expose an HTTP status on throw).
