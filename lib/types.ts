/**
 * Shared type contract for Batch Creative Studio.
 *
 * Owner: `backend` (X1) — authored here, READ by all agents. This is the single
 * source of truth for domain entities and SSE event payloads. It mirrors
 * `docs/architecture.md` §7 (the contract authority) and `docs/product-flow.md`
 * §0 / §8. This module is isomorphic and dependency-free, so it is one of the
 * only modules permitted to cross the L1↔L2 (client↔server) boundary
 * (architecture §3).
 *
 * Contract note (named status/outcome aliases): architecture §7.1 inlines the
 * status/outcome string unions directly on the entities. This file extracts
 * them into named aliases (`JobStatus`, `ItemStatus`, `AttemptOutcome`) per the
 * Task 1 contract, then references those aliases on the entities. The string
 * literals are identical, so the wire contract is unchanged — the aliases only
 * give the SSE payload types and downstream code a shared name to refer to.
 */

/**
 * Output aspect ratio for a generated post. Canonical home is here (X1);
 * `lib/providers/types.ts` re-exports this type (architecture §4 / §7.1).
 */
export type AspectRatio = "1:1" | "4:5" | "9:16";

/**
 * Job-level status.
 *
 * `failed` is reserved for a JOB-LEVEL precondition failure only (empty provider
 * chain or batch reference-normalization failing before any item runs — see
 * architecture §5.1, product-flow §0 / §4). Per-item failures never escalate
 * past `completed_with_errors`; all-items-failed is `completed_with_errors`
 * (done=0, failed=N), not `failed`.
 */
export type JobStatus = "running" | "completed" | "completed_with_errors" | "failed";

/** Item-level status (product-flow §0 / §3). */
export type ItemStatus = "queued" | "running" | "succeeded" | "failed";

/** Outcome of a single provider attempt (architecture §7.1, product-flow §0). */
export type AttemptOutcome = "success" | "retryable_error" | "fatal_error";

/**
 * One Generate run: holds the batch params, the reference image URLs, and N
 * Items. `perImageHints` lives on `Job.params` (keyed by `productImageUrl`) and
 * is resolved at the composition root when building each Item's `GenerateInput`;
 * there is NO `Item.captionHint` field (decisions.md 2026-06-26, architecture §4).
 */
export type Job = {
  id: string;
  status: JobStatus;
  /** Per-batch deterministic seed, derived once at job creation (architecture §5.6). */
  seed: number;
  params: {
    aspectRatio: AspectRatio;
    brief?: string;
    /** Keyed by `productImageUrl` -> caption hint (architecture §4 prompt threading). */
    perImageHints?: Record<string, string>;
  };
  referenceImageUrls: string[];
  items: Item[];
  /** ISO-8601 timestamp. */
  createdAt: string;
};

/** One product image -> one post. Owns an ordered list of Attempts. */
export type Item = {
  id: string;
  jobId: string;
  productImageUrl: string;
  status: ItemStatus;
  attempts: Attempt[];
  result?: {
    imageUrl: string;
    providerId: string;
    usedImageReference: boolean;
  };
  error?: {
    code: string;
    message: string;
    lastProviderId: string;
  };
};

/** One call to one provider for one item. */
export type Attempt = {
  providerId: string;
  /** ISO-8601 timestamp. */
  startedAt: string;
  /** ISO-8601 timestamp; absent while the attempt is in flight. */
  finishedAt?: string;
  outcome: AttemptOutcome;
  errorMessage?: string;
};

/* ──────────────────────────────────────────────────────────────────────────
 * SSE event payloads
 *
 * Channel: `GET /api/jobs/:id/stream`. Field names are verbatim from
 * architecture §6.2 / product-flow §8. Each payload below is the JSON carried
 * in the SSE `data:` line. The monotonic SSE frame `id:` (used for
 * `Last-Event-ID` replay) is a transport concern, NOT part of these payloads.
 * ────────────────────────────────────────────────────────────────────────── */

/** `item.status` — an item enters `queued` (re-enqueue/retry) or `running`. */
export type ItemStatusEvent = {
  itemId: string;
  status: ItemStatus;
};

/** `item.result` — an item reached `succeeded` and its result Blob is written. */
export type ItemResultEvent = {
  itemId: string;
  imageUrl: string;
  providerId: string;
  usedImageReference: boolean;
};

/** `item.error` — an item reached terminal `failed`. */
export type ItemErrorEvent = {
  itemId: string;
  code: string;
  message: string;
  lastProviderId: string;
};

/** `job.progress` — emitted on every item terminal transition (and at stream open). */
export type JobProgressEvent = {
  done: number;
  failed: number;
  total: number;
};

/**
 * `job.done` — job first reaches a terminal status (re-emitted after a
 * retry-driven re-completion). `status` is a `JobStatus`; at emit time it is
 * always one of the terminal values (`completed | completed_with_errors |
 * failed`), never `running`.
 */
export type JobDoneEvent = {
  status: JobStatus;
};

/** The exact SSE event names (architecture §6.2 / product-flow §8). */
export type SseEventName =
  | "item.status"
  | "item.result"
  | "item.error"
  | "job.progress"
  | "job.done";

/**
 * Map from SSE event name to its `data:` payload type. Lets the SSE server
 * (Task 6) and SSE client (Task 7) share one strongly-typed contract without
 * inventing any field the docs do not define.
 */
export type SseEventMap = {
  "item.status": ItemStatusEvent;
  "item.result": ItemResultEvent;
  "item.error": ItemErrorEvent;
  "job.progress": JobProgressEvent;
  "job.done": JobDoneEvent;
};
