---
component: UploadsRoute
source: app/api/uploads/route.ts
agent: backend
updated: 2026-06-28
---

# UploadsRoute

## Purpose
Server side of Vercel Blob **client uploads**: mints a short-lived, constraint-baked client token so the browser uploads image bytes **directly** to Blob. This is the only place `BLOB_READ_WRITE_TOKEN` is read; the secret never reaches the browser and image bytes never pass through this function.

## Public Interface
- `POST /api/uploads` → `NextResponse` — `@vercel/blob`'s `handleUpload()` token-exchange endpoint. Returns the `handleUpload` JSON response (a `{ type: "blob.generate-client-token", clientToken }` body) on success, or `{ error }` with status 400/500.
- `export const runtime = "nodejs"`, `export const dynamic = "force-dynamic"` — never statically cached.

## Inputs and Outputs
- **Accepts:** a `HandleUploadBody` JSON body POSTed by the browser's `@vercel/blob/client` `upload()` helper (token-generation phase).
- **Validates inside `onBeforeGenerateToken`:**
  - `kind` parsed from `clientPayload` (`JSON.stringify({ kind })`) — must be `product` | `reference`.
  - `pathname` must start with `uploads/{kind}/` (path-injection guard; realizes the `uploads/{kind}/{uuid}.{ext}` layout via `addRandomSuffix`).
  - Returns token constraints baked authoritatively server-side: `allowedContentTypes` ∈ {image/png, image/jpeg, image/webp}, `maximumSizeInBytes` = 10 MB, `addRandomSuffix: true`, `tokenPayload` = `{ kind }`.
- **Returns:** the minted client-token JSON; the client then PUTs bytes straight to Blob and gets the durable `.url`.
- **Errors:** `500` if `BLOB_READ_WRITE_TOKEN` is unset; `400` for non-JSON body, invalid/missing `kind`, bad `pathname`, or any token-mint failure.

## Dependencies
- `@vercel/blob/client` (`handleUpload`, `HandleUploadBody`) — the supported two-phase client-upload mechanism.
- `next/server` (`NextResponse`).
- Env: `BLOB_READ_WRITE_TOKEN` (server-only Blob write secret).

## Key Decisions
- **No `onUploadCompleted` callback** (decisions 2026-06-28): registering it forces `@vercel/blob` to embed a callback URL in the token, which it cannot determine on localhost ("no callbackUrl could be determined"), breaking dev uploads. The MVP keeps state in-memory and `upload()` returns the durable `.url` directly, so no callback is needed.
- **Two-phase token exchange, not a presigned PUT** — the real `@vercel/blob` API diverges from the idealized `{ uploadUrl, blobUrl }` contract; the frontend must drive uploads with `upload()`.
- Size and content-type limits are baked into the token so Blob itself rejects oversize/wrong-type uploads (no client-declared size is trusted).

## Known Limitations
- **Frontend contract mismatch:** the documented client (`lib/client/uploadClient.ts`) historically expected `{ uploadUrl, blobUrl }` + a manual PUT, which does not exist; the client must call `@vercel/blob/client` `upload()` with `handleUploadUrl: "/api/uploads"`, a `uploads/${kind}/` pathname, and `clientPayload: JSON.stringify({ kind })`.
- Requires a **public** Blob store; `access: "public"` writes fail against a Private store.
- No auth — single-user MVP.
