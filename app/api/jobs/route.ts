/**
 * Job creation endpoint — `POST /api/jobs` (component C8, backend — BE).
 *
 * Creates a Job + N `queued` Items and returns `{ jobId }`. It does NOT start
 * generation: orchestration is hosted by `GET /api/jobs/:id/stream`, which the
 * client opens immediately after this returns (architecture §1 / §6, product-flow
 * §2.7/§8). The order of guards mirrors product-flow §2.7:
 *   1. per-IP rate limit (429 on exceed);
 *   2. job-creation idempotency (`Idempotency-Key` header → same jobId in-window);
 *   3. payload validation (counts, aspect-ratio enum, hint shape) — 400;
 *   4. SSRF validation of every product + reference URL (https + Vercel Blob host
 *      allowlist + private-range block) — 400;
 *   5. derive the per-batch `seed` and persist Job + Items.
 *
 * Secrets stay server-side; this route reads none.
 */

import { NextResponse } from "next/server";
import { lookupIdempotentJob, rememberIdempotentJob } from "@/lib/api/job-idempotency";
import { checkJobRateLimit, clientIp } from "@/lib/api/rate-limit";
import { checkUserImageUrls } from "@/lib/api/ssrf";
import { maxItems } from "@/lib/orchestrator/config";
import { deriveSeed } from "@/lib/orchestrator/orchestrator";
import { getStateStore } from "@/lib/state";
import type { AspectRatio, Item, Job } from "@/lib/types";

// Node runtime + always-dynamic: mints in-memory job state from a per-request
// body and must never be statically cached (architecture §11).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ASPECT_RATIOS: readonly AspectRatio[] = ["1:1", "4:5", "9:16"];

/** Shape we accept after validation. */
type ValidParams = {
  aspectRatio: AspectRatio;
  brief?: string;
  perImageHints?: Record<string, string>;
};
type ValidBody = {
  productImageUrls: string[];
  referenceImageUrls: string[];
  params: ValidParams;
};

type ValidationResult = { ok: true; body: ValidBody } | { ok: false; reason: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Validate the request body shape, counts, and enums (URLs SSRF-checked later). */
function validateBody(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  if (!isStringArray(body.productImageUrls)) {
    return { ok: false, reason: "productImageUrls must be an array of strings" };
  }
  const max = maxItems();
  if (body.productImageUrls.length < 1 || body.productImageUrls.length > max) {
    return { ok: false, reason: `productImageUrls must contain 1..${max} items` };
  }

  if (!isStringArray(body.referenceImageUrls)) {
    return { ok: false, reason: "referenceImageUrls must be an array of strings" };
  }
  if (body.referenceImageUrls.length < 1 || body.referenceImageUrls.length > 2) {
    return { ok: false, reason: "referenceImageUrls must contain 1..2 items" };
  }

  if (typeof body.params !== "object" || body.params === null) {
    return { ok: false, reason: "params must be an object" };
  }
  const params = body.params as Record<string, unknown>;

  if (!ASPECT_RATIOS.includes(params.aspectRatio as AspectRatio)) {
    return { ok: false, reason: `params.aspectRatio must be one of ${ASPECT_RATIOS.join(", ")}` };
  }

  if (params.brief !== undefined && typeof params.brief !== "string") {
    return { ok: false, reason: "params.brief must be a string when present" };
  }

  let perImageHints: Record<string, string> | undefined;
  if (params.perImageHints !== undefined) {
    if (
      typeof params.perImageHints !== "object" ||
      params.perImageHints === null ||
      Array.isArray(params.perImageHints)
    ) {
      return { ok: false, reason: "params.perImageHints must be a string→string map when present" };
    }
    const map = params.perImageHints as Record<string, unknown>;
    for (const [key, value] of Object.entries(map)) {
      if (typeof value !== "string") {
        return { ok: false, reason: `params.perImageHints["${key}"] must be a string` };
      }
    }
    perImageHints = map as Record<string, string>;
  }

  const validParams: ValidParams = { aspectRatio: params.aspectRatio as AspectRatio };
  if (typeof params.brief === "string") validParams.brief = params.brief;
  if (perImageHints !== undefined) validParams.perImageHints = perImageHints;

  return {
    ok: true,
    body: {
      productImageUrls: body.productImageUrls,
      referenceImageUrls: body.referenceImageUrls,
      params: validParams,
    },
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Per-IP rate limit (abuse guard — architecture §9 / product-flow §5h).
  const rate = checkJobRateLimit(clientIp(request));
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many job requests. Please retry shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  // 2. Job-creation idempotency: same Idempotency-Key in-window → same jobId.
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || undefined;
  if (idempotencyKey) {
    const existing = lookupIdempotentJob(idempotencyKey);
    if (existing) return NextResponse.json({ jobId: existing }, { status: 201 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body: expected JSON." }, { status: 400 });
  }

  // 3. Shape / count / enum validation.
  const validation = validateBody(raw);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }
  const { productImageUrls, referenceImageUrls, params } = validation.body;

  // 4. SSRF validation of every user-supplied URL (https + Blob host allowlist).
  const productCheck = checkUserImageUrls(productImageUrls, "productImageUrls");
  if (!productCheck.ok) {
    return NextResponse.json({ error: productCheck.reason }, { status: 400 });
  }
  const referenceCheck = checkUserImageUrls(referenceImageUrls, "referenceImageUrls");
  if (!referenceCheck.ok) {
    return NextResponse.json({ error: referenceCheck.reason }, { status: 400 });
  }

  // Re-check idempotency right before the synchronous create so a concurrent
  // duplicate that raced past step 2 still collapses onto one Job (the
  // check→reserve below runs without an await, so it is atomic in-process).
  if (idempotencyKey) {
    const existing = lookupIdempotentJob(idempotencyKey);
    if (existing) return NextResponse.json({ jobId: existing }, { status: 201 });
  }

  // 5. Materialize the Job + N queued Items; set the per-batch deterministic seed.
  const jobId = crypto.randomUUID();
  const items: Item[] = productImageUrls.map((productImageUrl) => ({
    id: crypto.randomUUID(),
    jobId,
    productImageUrl,
    status: "queued",
    attempts: [],
  }));
  const job: Job = {
    id: jobId,
    status: "running",
    seed: deriveSeed(jobId),
    params,
    referenceImageUrls,
    items,
    createdAt: new Date().toISOString(),
  };
  await getStateStore().createJob(job);
  if (idempotencyKey) rememberIdempotentJob(idempotencyKey, jobId);

  // Do NOT start runJob here — the stream handler hosts it (architecture §6).
  return NextResponse.json({ jobId }, { status: 201 });
}
