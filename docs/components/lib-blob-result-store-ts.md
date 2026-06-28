---
component: ResultStore
source: lib/blob/result-store.ts
agent: backend
updated: 2026-06-28
---

# ResultStore

## Purpose
The sole writer of result image bytes (component C19). After a provider returns, `persistResult` writes the image to Vercel Blob under a stable per-item key with last-writer-wins semantics, so an item never yields more than one distinct result blob and there are no orphans.

## Public Interface
- `function persistResult(args: PersistResultArgs): Promise<PersistedResult>` — persist one item's result bytes (or re-fetch a provider URL), return the public URL + resolved content-type.
- `type PersistResultArgs` — `jobId`, `itemId`, `imageBytes: Uint8Array | string` (raw bytes or a provider URL to re-persist), optional `contentType` (adapter-declared MIME), optional `signal` (job-level abort).
- `type PersistedResult` — `imageUrl`, `contentType`.

## Inputs and Outputs
- Writes to Blob key `results/{jobId}/{itemId}.{ext}` where `{ext}` derives from the resolved content-type (png/jpg/webp, default png).
- When `imageBytes` is a string URL: fetches it under an SSRF guard (https only, blocked private/loopback/link-local/metadata hosts, `redirect: "error"`, 30s timeout, 25 MiB cap, non-empty), resolving content-type as response header → adapter `contentType` → magic-byte sniff.
- When `imageBytes` is raw bytes: rejects zero-length; content-type = adapter `contentType` (if allowed) → magic-byte sniff.
- `put()` uses `addRandomSuffix: false` + `allowOverwrite: true` for last-writer-wins; `access: "public"`; `abortSignal` threaded.
- Throws on missing `BLOB_READ_WRITE_TOKEN`, empty/invalid body, oversized/forbidden fetch, or Blob failure — caller classifies these as retryable.
- Allowed content types: `image/png`, `image/jpeg`, `image/webp`.

## Dependencies
- `@vercel/blob` — `put()` (v2.5.0, server token-based write).

## Key Decisions
- The per-item key is attempt-independent and overwritten by every successful attempt (initial, retry, failover, post-terminal targeted retry), so `item.result.imageUrl` always points at the stable per-item Blob, never an ephemeral provider URL.
- Adapter-declared `contentType` is preferred over magic-byte sniffing for `{ext}` so the key stays stable across a format-changing failover (e.g. Gemini PNG → Cloudflare WEBP).
- `BLOB_READ_WRITE_TOKEN` is read here and stays server-side; adapters never persist.
- This module has its OWN SSRF guard (`isBlockedHost`) for provider-result URLs — distinct from `lib/api/ssrf.ts` which validates user-supplied input URLs.

## Known Limitations
- The SSRF host check is literal-IP / known-host based (no DNS resolution), so it cannot catch a hostname that resolves to a private IP.
- 25 MiB result cap and 30s fetch timeout are fixed constants.
