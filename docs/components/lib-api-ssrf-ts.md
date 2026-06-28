---
component: SsrfGuard
source: lib/api/ssrf.ts
agent: backend
updated: 2026-06-28
---

# SsrfGuard

## Purpose
Pure, synchronous SSRF validator for user-supplied image URLs (`productImageUrls` + `referenceImageUrls` on `POST /api/jobs`), run before any Job/Item exists and before any adapter fetches the URL.

## Public Interface
- `function checkUserImageUrl(raw: unknown): SsrfCheck` — validate one URL.
- `function checkUserImageUrls(values: unknown[], label: string): { ok: true } | { ok: false; reason: string }` — validate an array; returns the first failure with offending index.
- `function isBlockedHost(hostname: string): boolean` — true for private/loopback/link-local/unique-local/metadata hosts.
- `type SsrfCheck = { ok: true; url: URL } | { ok: false; reason: string }`.

## Inputs and Outputs
- `checkUserImageUrl` rejects: non-string/empty; unparseable URL; non-`https:` scheme; embedded credentials (`user`/`password`); blocked host; host not on the Vercel Blob allowlist. On success returns the parsed `URL`.
- `checkUserImageUrls` iterates and returns `{ ok: false, reason: "<label>[<i>] <reason>" }` on the first bad entry.
- `isBlockedHost` covers literal IPv4 (0/8, 10/8, 127/8, 169.254/16, 172.16–31, 192.168/16, 100.64/10 CGNAT), literal IPv6 (`::1`, `::`, `fc`/`fd` ULA, `fe80` link-local), and `localhost`/`*.localhost`/`metadata.google.internal`/`*.internal`. Strips IPv6 brackets.
- Allowlist: `BLOB_ALLOWED_HOST_SUFFIXES` (CSV) or default `.public.blob.vercel-storage.com`; matches host suffix or the bare suffix host.
- Does NOT fetch anything (no redirects to follow).

## Dependencies
None.

## Key Decisions
- Allowlist enforces that every image URL originated from `/api/uploads` (a Vercel Blob host), not an arbitrary remote.
- The private/metadata host block is kept as explicit defense-in-depth even though the allowlist already excludes such hosts — it survives a looser allowlist override.
- Distinct from the provider-result SSRF guard in `lib/blob/result-store.ts` (that one re-persists provider output URLs; this one vets user input).

## Known Limitations
- No DNS resolution — a allowlisted-but-malicious hostname resolving to a private IP would not be caught here (the allowlist is the primary control).
- Synchronous string/IP-literal checks only.
