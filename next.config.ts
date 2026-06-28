import type { NextConfig } from "next";

/**
 * Minimal Next.js configuration (scaffold — Task 1, backend).
 *
 * Batch Creative Studio relies on Vercel Fluid Compute + streaming Route
 * Handlers for the SSE batch stream (`GET /api/jobs/:id/stream`). That handler
 * hosts the orchestrator inline and emits progressive `item.*` / `job.*` events
 * over `text/event-stream` (see docs/architecture.md §6 and docs/product-flow.md
 * §8). The full runtime config — e.g. a raised function `maxDuration` (~300s) to
 * cover N<=20 batches (architecture §6.4 / §11) — is tuned in later backend
 * tasks. This file is intentionally minimal for the scaffold.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
