/**
 * Backend orchestration tunables (backend — BE).
 *
 * All reliability/concurrency knobs are env-driven (changeable WITHOUT a
 * redeploy — product-flow §10, decisions.md 2026-06-26). Provider-specific
 * numbers (RPM, daily quota) live in providers config and are consumed via the
 * registry; THESE are the backend-owned orchestration knobs. Defaults match
 * `.env.example` / architecture §11 (`POOL_SIZE`, `ATTEMPT_CAP`,
 * `ATTEMPT_TIMEOUT_MS`, backoff base/cap, `MAX_ITEMS`).
 */

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function fractionFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

/** Bounded worker-pool concurrency (`POOL_SIZE`, default 5; spec range 4–6). */
export function poolSize(): number {
  return positiveIntFromEnv("POOL_SIZE", 5);
}

/** Attempts per provider (`ATTEMPT_CAP`, default 3 = attempts 0..2). */
export function attemptCap(): number {
  return positiveIntFromEnv("ATTEMPT_CAP", 3);
}

/** Per-attempt provider-call timeout in ms (`ATTEMPT_TIMEOUT_MS`, default 60000). */
export function attemptTimeoutMs(): number {
  return positiveIntFromEnv("ATTEMPT_TIMEOUT_MS", 60_000);
}

/** Exponential-backoff base in ms (`BACKOFF_BASE_MS`, default 500). */
export function backoffBaseMs(): number {
  return positiveIntFromEnv("BACKOFF_BASE_MS", 500);
}

/** Exponential-backoff cap in ms (`BACKOFF_MAX_MS`, default 8000). */
export function backoffMaxMs(): number {
  return positiveIntFromEnv("BACKOFF_MAX_MS", 8_000);
}

/** Max product images per batch / N bound (`MAX_ITEMS`, default 20). */
export function maxItems(): number {
  return positiveIntFromEnv("MAX_ITEMS", 20);
}

/** Daily-quota soft threshold fraction for the pre-switch hook (default 0.9). */
export function quotaSoftFraction(): number {
  return fractionFromEnv("QUOTA_SOFT_FRACTION", 0.9);
}
