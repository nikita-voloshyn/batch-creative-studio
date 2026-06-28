---
component: OrchestratorConfig
source: lib/orchestrator/config.ts
agent: backend
updated: 2026-06-28
---

# OrchestratorConfig

## Purpose
Backend-owned, env-driven orchestration tunables (concurrency, retry, backoff, quota). All knobs are read from `process.env` at call time so they can change WITHOUT a redeploy. Provider-specific numbers (RPM, daily quota) live in the providers config; these are the backend orchestration knobs only.

## Public Interface
- `poolSize(): number` — `POOL_SIZE`, default 5 (spec range 4–6). Worker-pool concurrency.
- `attemptCap(): number` — `ATTEMPT_CAP`, default 3 (attempts 0..2). Attempts per provider.
- `attemptTimeoutMs(): number` — `ATTEMPT_TIMEOUT_MS`, default 60000. Per-attempt provider-call timeout.
- `backoffBaseMs(): number` — `BACKOFF_BASE_MS`, default 500. Exponential-backoff base.
- `backoffMaxMs(): number` — `BACKOFF_MAX_MS`, default 8000. Exponential-backoff cap.
- `maxItems(): number` — `MAX_ITEMS`, default 20. Max product images per batch (N bound).
- `quotaSoftFraction(): number` — `QUOTA_SOFT_FRACTION`, default 0.9. Daily-quota soft threshold for the failover pre-switch hook.

## Inputs and Outputs
- Each accessor reads its env var fresh on every call (no caching), so changing the env mid-process takes effect immediately.
- Validation: positive-int accessors fall back to the default when the var is unset/blank or parses to a non-finite or non-positive integer. `quotaSoftFraction` requires a parsed float in `(0, 1]`, else falls back to 0.9.

## Dependencies
- None (reads `process.env` directly).

## Key Decisions
- Functions rather than module constants so values are re-read per call, supporting runtime reconfiguration without a redeploy (decisions.md 2026-06-26).
- Strict validation guards against malformed env values silently breaking reliability behavior — invalid input always degrades to the documented default.
- Defaults are kept aligned with `.env.example` / architecture §11.

## Known Limitations
- No caching: each call re-parses the env var (negligible cost, but not memoized).
- No upper-bound clamping beyond positivity (e.g. an extreme `POOL_SIZE` is accepted as-is).
