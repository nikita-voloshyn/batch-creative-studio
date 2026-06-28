# Security Review — Server Surface & Outbound-Fetch Paths (Task 12)

- **Agent:** `security-backend` (review-only — no production code modified; output confined to `docs/security/**`)
- **Date:** 2026-06-28
- **Scope:** the server surface and every server-side outbound fetch:
  `app/api/uploads/route.ts`, `app/api/jobs/route.ts`, `app/api/jobs/[id]/*`,
  `lib/api/{ssrf,rate-limit,job-idempotency}.ts`, `lib/blob/result-store.ts`,
  `lib/providers/{gemini,cloudflare,replicate,reference-normalize,config}.ts`,
  `lib/orchestrator/*.ts`, `lib/ratelimit/token-bucket.ts`, `lib/state/store.ts`.
- **Out of scope (per directives):** authN/JWT/cookie/session findings — the product is intentionally no-auth single-user.
- **Method:** read of all source above; data-flow / trust-boundary tracing; Context7 against Next.js 16.2.9, `@vercel/storage` (Blob v2.5.0); OWASP Cheat Sheets (SSRF Prevention, Input Validation, Node.js Security, REST Security, File Upload); `semgrep p/owasp-top-ten`, `pnpm audit`, secret grep.

---

## 1. Verdict

**APPROVED — no Critical/High unmitigated issues.**

The central SSRF trust boundary is **sound**: the only Job-creation path (`POST /api/jobs`) SSRF-validates **every** product + reference URL before any `Job`/`Item` exists, the validated URLs are stored verbatim, and those are the only URLs the orchestrator threads into provider fetches. No unvalidated user URL can reach a server-side fetch. The default Blob allowlist is airtight. Uploads, secret handling, idempotency, and structured logging are correct and Context7-verified.

Five **Medium** and two **Low** hardening items are handed to `backend`/`providers` below. None is remotely exploitable in the default configuration; however, **F1 + F2 + F4 would escalate to High** if an operator loosens `BLOB_ALLOWED_HOST_SUFFIXES` or sets `REPLICATE_ENABLED=true`, so they should be fixed before any such config change.

### Findings by severity

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 4 | F1, F2, F3, F5 |
| Low | 2 | F4, F6 |

---

## 2. Threat model (trust boundaries)

```
                 (untrusted client, NO auth)
                          │
          ┌───────────────┼─────────────────────────────┐
          ▼               ▼                               ▼
  POST /api/uploads   POST /api/jobs            GET /api/jobs/:id[/stream]
  (mint Blob token)   (create job)             POST .../items/:itemId/retry
          │               │                               │
   token bakes:           │ guards (in order):             │ reuse STORED
   - contentType allowlist│  1. per-IP rate limit          │ (already-validated)
   - 10MB max size        │  2. idempotency key            │ productImageUrl
   - kind enum            │  3. shape/count/enum 400        │
   - pathname prefix      │  4. SSRF allowlist on EVERY url │
          │               │  5. persist Job + N Items       │
          ▼               ▼                               ▼
   direct browser→Blob  stateStore (in-mem)  ───────► orchestrator (runJob/retryItem)
                                                          │
                              ┌───────────────────────────┼──────────────────────────┐
                              ▼ normalizeReferences        ▼ provider.generate         ▼ persistResult
                       fetch(refUrl) → data:URL     fetch(productImageUrl)       fetch(providerResultUrl)
                       reference-normalize.ts        reference-normalize.ts        result-store.ts
                       [OUTBOUND FETCH #1]            [OUTBOUND FETCH #2]           [OUTBOUND FETCH #3]
```

**Outbound-fetch SSRF surface = the three fetch points.** Fetches #1 and #2 are the *same* helper (`fetchImageAsInlineData`) and consume URLs that were SSRF-validated at job creation; fetch #3 consumes a **provider-returned** URL (Replicate only) re-checked by an independent guard.

**Trust-boundary conclusion (directive 1b):** the only writer of `item.productImageUrl` / `job.referenceImageUrls` is `POST /api/jobs`, which runs `checkUserImageUrls()` *before* `stateStore.createJob()` (`app/api/jobs/route.ts:151-186`). The retry route (`.../retry/route.ts`) re-drives the **stored** item and never accepts a new URL. So although fetches #1/#2 carry **no independent SSRF re-check** (documented as intentional in `reference-normalize.ts:17-19`), every URL they see was validated. The trust boundary is sound — but it is a *single* validation point with no defense-in-depth at the fetch (see F1).

---

## 3. Findings

### F1 — `fetchImageAsInlineData` follows HTTP redirects without re-validation (and has no independent timeout). Medium

- **File:** `lib/providers/reference-normalize.ts:108` (`fetch(url, signal ? { signal } : undefined)`), reached for the product image (`gemini.ts:64`, `cloudflare.ts:154`) and reference images (`normalizeReferences` → `reference-normalize.ts:138`).
- **Issue:** the WHATWG `fetch` default is `redirect: "follow"`. The SSRF policy validates the **initial** host against the Vercel Blob allowlist, but the redirect **target** is never re-checked. The sibling provider-URL guard correctly opts out (`result-store.ts:154` sets `redirect: "error"`); this primary fetch path does not — an asymmetry that signals an oversight. There is also no per-fetch `AbortSignal.timeout()`; the path relies entirely on the orchestrator's attempt-level signal.
- **Attack scenario:** if an allowlisted host (or, after a loosened `BLOB_ALLOWED_HOST_SUFFIXES`, any host) returns `302 Location: http://169.254.169.254/latest/meta-data/...` or `http://127.0.0.1:<port>/`, the server-side fetch follows it cross-protocol and reads the internal response into the provider request. In the default config this requires an open-redirect on a Vercel-controlled host (low likelihood), which is why this is Medium rather than High — but "do not follow redirects to internal targets" is a core SSRF criterion and the fix is trivial.
- **Citations:** Context7 — Next.js 16.2.9 route handlers run on the Node/WHATWG `fetch` whose default redirect mode is `follow`; the guard must opt out explicitly. OWASP **SSRF Prevention Cheat Sheet** ("Disable HTTP redirections" / re-validate the destination after every redirect) and **Node.js Security Cheat Sheet** (constrain outbound requests, always set timeouts).
- **Recommended fix (→ providers):** set `redirect: "error"` (or `"manual"` and re-run `isBlockedHost`/allowlist on the `Location` before re-fetching), and pass an `AbortSignal.timeout(...)` composed with the existing signal, mirroring `result-store.ts:152-154`.

### F2 — `result-store.ts` provider-URL SSRF guard is a leaky denylist (no allowlist, no DNS resolution, incomplete IP-literal parsing). Medium

- **File:** `lib/blob/result-store.ts:113-131` (`isBlockedHost`), used by `fetchProviderResult` (`:148`).
- **Issue:** three gaps:
  1. **IP-literal parsing** only matches dotted-decimal IPv4 (`/^(\d{1,3})\.…$/`). Bypassed by `https://2130706433/` (decimal int for `127.0.0.1`), `https://0x7f000001/` (hex), `https://0177.0.0.1/` (octal), and IPv4-mapped IPv6 `https://[::ffff:127.0.0.1]/` (host `::ffff:127.0.0.1` matches none of the `::1`/`fc`/`fd`/`fe80` checks).
  2. **No allowlist** — any public hostname passes.
  3. **No DNS resolution** — `https://attacker.example/` that resolves to `169.254.169.254` (or any private range) passes the host-string check and is then fetched.
- **Mitigations already present (reduce severity):** `https`-only (`:145`), `redirect: "error"` (`:154`), 30s timeout (`:152`), 25 MiB cap (`:160`).
- **Trigger / why Medium:** this guard is only reached for a **provider-returned URL** (`imageBytes: string`), which today only Replicate emits, and Replicate is **off by default** (`REPLICATE_ENABLED=false`). Exploitation additionally requires an attacker to influence the provider `output` URL (normally `replicate.delivery`). Gated + provider-controlled ⇒ Medium, but the guard is materially weaker than the route-layer one.
- **Citations:** Context7 — `@vercel/blob` `put()` (v2.5.0) re-persists the fetched bytes; the fetch is plain Node `fetch`. OWASP **SSRF Prevention Cheat Sheet** ("validate the resolved IP, block all reserved ranges, account for alternative IP encodings: decimal/octal/hex/IPv4-mapped-IPv6"; prefer an allowlist of expected destination hosts).
- **Recommended fix (→ backend):** prefer an allowlist of known provider-result hosts (e.g. suffix `.replicate.delivery`); and/or resolve the hostname and apply the block to the **resolved** IP; close the IP-literal encodings (reuse a hardened shared blocker — see F4).

### F3 — Per-IP rate limit is bypassable via spoofable `X-Forwarded-For`. Medium

- **File:** `lib/api/rate-limit.ts:58-67` (`clientIp`) — uses `forwarded.split(",")[0]` (the **leftmost** XFF entry) as the bucket key; the `x-real-ip` fallback (`:64`) never fires because XFF is always present on Vercel.
- **Issue:** the leftmost `X-Forwarded-For` value is fully client-controlled. The trustworthy client IP is the value the trusted proxy adds — on Vercel, `x-real-ip` (or the **rightmost** XFF entry). Keying the limiter on the leftmost entry lets a client mint a fresh token bucket per request.
- **Attack scenario:** an attacker sends `X-Forwarded-For: <random-ip>` (rotated every request) to `POST /api/jobs`. Each value keys a new bucket, so the per-IP limit (`JOBS_RATE_LIMIT_PER_MIN`, default 30) — the **only** abuse control on the no-auth job-creation endpoint — is defeated, enabling unbounded job creation (provider-API cost amplification + in-memory state growth). In a self-hosted deploy with no trusted proxy in front, the spoof is unconditional.
- **Citations:** Context7 — Next.js App Router route handlers expose only request headers (no `request.ip`); Vercel sets `x-real-ip` / `x-vercel-forwarded-for` to the real client IP. OWASP **REST Security Cheat Sheet** + **Denial of Service** guidance — never trust client-supplied `X-Forwarded-For` for security decisions; use the proxy-appended value.
- **Recommended fix (→ backend):** derive the IP from the platform-trusted source — `request.headers.get('x-real-ip')` first, or the **rightmost** XFF entry, or `@vercel/functions` `ipAddress(request)`. Do not key on the leftmost XFF.

### F5 — No length / cardinality caps on `params.brief` and `params.perImageHints`. Medium

- **File:** `app/api/jobs/route.ts:83-103` — `brief` validated only as `typeof === "string"`; `perImageHints` validated only as a string→string map. No max length on `brief`, no max length on hint values, no cap on `Object.keys(perImageHints).length`.
- **Issue / why bounded:** Context7 confirms Next.js 16.2.9 caps the whole request body at **10 MB** by default (`proxyClientMaxBodySize: 10_485_760`), and Vercel adds a ~4.5 MB function-request cap — both bound raw memory DoS. **But:** (a) a near-10 MB `brief` is concatenated into the prompt (`prompt.ts:66`) and sent to the **paid** provider API for **each** of up to 20 items → ~200 MB of outbound provider payload + token cost per batch (cost-amplification); (b) `proxyClientMaxBodySize` is configurable and absent on non-Vercel hosts; (c) OWASP requires explicit length bounds on all free-text inputs regardless of transport limits.
- **Attack scenario:** repeated `POST /api/jobs` (amplified by F3) with a maximal `brief` / a `perImageHints` map of thousands of entries drives provider spend and memory.
- **Citations:** Context7 — Next.js `proxyClientMaxBodySize` (default 10 MB, configurable). OWASP **Input Validation Cheat Sheet** ("enforce a minimum and maximum length on every string input").
- **Recommended fix (→ backend):** cap `brief` (e.g. ≤ 2 000 chars), cap each hint value (e.g. ≤ 500 chars), and cap `Object.keys(perImageHints).length` (e.g. ≤ `MAX_ITEMS`); return 400 on exceed.

### F4 — `lib/api/ssrf.ts` `isBlockedHost` shares the IP-literal-encoding gaps (latent; behind the airtight allowlist). Low

- **File:** `lib/api/ssrf.ts:58-79`.
- **Issue:** the same encoding gaps as F2 (decimal/octal/hex IPv4, IPv4-mapped IPv6). **Not exploitable in the default config:** `checkUserImageUrl` (`:99-104`) requires **both** `!isBlockedHost` **and** `isAllowedBlobHost`, and `isAllowedBlobHost` (`:43-50`) demands `hostname.endsWith(".public.blob.vercel-storage.com")`. An attacker cannot register a subdomain of Vercel's blob domain, and an IP-literal host never ends with that suffix, so it is rejected by the allowlist regardless of the denylist gaps. **The allowlist is airtight (directive 1a: confirmed).** The gaps become live only if an operator widens `BLOB_ALLOWED_HOST_SUFFIXES`.
- **Citations:** OWASP **SSRF Prevention Cheat Sheet** (alternative IP encodings). Context7 — guard runs in a Node route handler; no DNS layer here by design (pure validator).
- **Recommended fix (→ backend, defense-in-depth):** harden the IP-literal parser (cover decimal/octal/hex + IPv4-mapped IPv6) and share one blocker between `ssrf.ts` and `result-store.ts` (also closes F2's parsing gap); keep the allowlist as the primary gate.

### F6 — Transitive moderate advisory: `postcss < 8.5.10` (GHSA-qx2v-qp2m-jg93). Low

- **Path:** `. > next > postcss` (build-time dependency; not in the request/runtime path).
- **Issue:** PostCSS XSS via unescaped `</style>` in CSS stringify output — affects CSS authoring tools, not this app's server surface. `pnpm audit --audit-level=high` reports **0** high; this is the single moderate.
- **Recommended fix (→ backend):** bump the transitive `postcss` to ≥ 8.5.10 (pnpm override) at the next dependency refresh.

---

## 4. Compliant / verified (no action needed)

- **Trust boundary sound:** every provider-fetched URL was SSRF-validated at `POST /api/jobs` before storage; no unvalidated URL reaches a fetch (§2).
- **Blob allowlist airtight** in default config (Vercel-controlled domain; IP-literal hosts rejected) — directive 1a.
- **Upload safety (Context7-verified, Blob v2.5.0):** `onBeforeGenerateToken` bakes `allowedContentTypes` (png/jpeg/webp) + `maximumSizeInBytes` (10 MB) **into the client token** (server-authoritative — Blob rejects oversize/wrong-type at the PUT), enforces the `kind` enum, and guards the pathname with a `uploads/{kind}/` prefix. Blob keys are flat object keys (no filesystem path-traversal from `..`); `addRandomSuffix: true` guarantees uniqueness. `app/api/uploads/route.ts:120-133`.
- **Secret handling:** `GEMINI_API_KEY`, `CLOUDFLARE_*`, `REPLICATE_API_TOKEN`, `BLOB_READ_WRITE_TOKEN` read only via `process.env.*` server-side (`config.ts`, `result-store.ts:179`, `uploads/route.ts:102`); secret accessors are **not** re-exported from the providers barrel (`index.ts` comment + verified); never placed in `GenerateResult`, an SSE payload, or an HTTP response. No hardcoded secret (secret grep §5). No `.env` tracked; `.gitignore` excludes `.env`/`.env.*` and keeps `.env.example`.
- **Sensitive-data logging:** structured logs (`orchestrator.ts:455-486`, `:576`; stream/retry route `console.error`) carry only `jobId`/`itemId`/`providerId`/`outcome`/`errorCode`/`reason` — **no** blob URLs, API keys, or PII. All result + upload blobs are `access: "public"`, so their URLs carry **no** token; even the SSE `item.result.imageUrl` is not a secret-bearing signed URL. Directive 5 satisfied.
- **Input validation (counts/enums):** product count 1..`MAX_ITEMS` (≤20), reference count 1..2, `aspectRatio` ∈ {1:1,4:5,9:16}, hint shape checked (`jobs/route.ts:59-103`). The validator uses an allowlist read (unknown fields ignored, not trusted) — the safe pattern.
- **Idempotency:** `Idempotency-Key` + double check-then-reserve around the synchronous create (`jobs/route.ts:131-187`) is atomic under single-threaded JS.
- **`result-store` partial SSRF mitigations:** `https`-only + `redirect: "error"` + 30s timeout + 25 MiB cap (counterweight to F2).

---

## 5. Verification results

**Secret grep** — `grep -rn 'API_KEY\|SECRET\|TOKEN\|PRIVATE_KEY\|Bearer ' app lib --include='*.ts' | grep -v '.env.example'`:
all matches are env-var reads (`process.env.*`), doc comments, or `Authorization: Bearer ${apiToken}` template literals (variable interpolation, not a literal credential). **No hardcoded secret.**

**`semgrep --config p/owasp-top-ten --severity=ERROR --severity=WARNING app lib`** (semgrep 1.168.0):
`Ran 77 rules on 37 files: 0 findings.` **0 findings, 0 scan errors.**
(Note: the directive's `npx semgrep` invocation fails — semgrep is a Python tool, not an npm package; it was installed via `pip3 install --user semgrep` and run as `semgrep` for this review.)

**`pnpm audit --audit-level=high`** — `0 high`. At `--audit-level=moderate`: **1 moderate** — `postcss < 8.5.10` (GHSA-qx2v-qp2m-jg93), transitive via `next`, build-time only (see F6).

**Other hygiene:** `next.config.ts` is minimal (no body-size override → default 10 MB applies); no `.env` files tracked; no `console.*` line references url/token/key/secret/productImage/imageUrl/apiKey/payload.

---

## 6. Handoff

| ID | Sev | Owner | One-line fix |
|----|-----|-------|--------------|
| F1 | Medium | providers | `reference-normalize.ts`: `redirect: "error"` + composed `AbortSignal.timeout()` on the fetch. |
| F2 | Medium | backend | `result-store.ts`: allowlist provider-result hosts and/or block on the resolved IP; close IP-literal encodings. |
| F3 | Medium | backend | `rate-limit.ts`: key the limiter on `x-real-ip` / rightmost XFF, not the leftmost. |
| F5 | Medium | backend | `jobs/route.ts`: cap `brief` / hint value lengths and `perImageHints` entry count; 400 on exceed. |
| F4 | Low | backend | `ssrf.ts`: harden IP-literal parsing; share one blocker with `result-store.ts`. |
| F6 | Low | backend | bump transitive `postcss` ≥ 8.5.10. |

**Boundary confirmation:** this review wrote only `docs/security/backend.md`. No production code, test, config, or `.claude/` file was modified.
