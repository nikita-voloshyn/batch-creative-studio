/**
 * Client batch store (component C5 seed, frontend).
 *
 * A small Zustand store holding the user's selection: product/reference files,
 * their per-file upload status + durable `blobUrl`s, optional per-image caption
 * hints, and the batch params (aspectRatio, brief). It is the read-model SEED
 * for Task 7 (the SSE-driven batch grid hydrates from here on Generate). This
 * task does NOT implement SSE, job submission, or the grid — `buildCreateJobRequest`
 * only assembles the typed `POST /api/jobs` payload (architecture §7.2) so Task 7
 * has a ready handoff.
 *
 * Browser-only state: a module-level store is correct here because nothing is
 * created or read during SSR (it starts empty and only mutates from client
 * interaction), so there is no cross-request state-sharing concern.
 */

"use client";

import { create } from "zustand";
import type { AspectRatio, Item, ItemStatus, Job, SseEventMap, SseEventName } from "@/lib/types";
import { MAX_PRODUCT_IMAGES, MAX_REFERENCE_IMAGES, validateImageFile } from "./fileValidation";
import { createJob, JobApiError, retryItem } from "./jobsClient";
import { type JobStreamController, openJobStream, type StreamConnectionState } from "./sseClient";
import { UploadError, type UploadKind, uploadFile } from "./uploadClient";

/** Per-file upload lifecycle (client-only; distinct from server Item status). */
export type UploadStatus = "uploading" | "uploaded" | "error";

/** One selected file and everything the UI + Task 7 need to know about it. */
export type UploadEntry = {
  /** Local id (stable across the entry's lifetime; not the server itemId). */
  id: string;
  kind: UploadKind;
  /** The raw browser File, kept until upload completes (never base64'd). */
  file: File;
  /** Object URL for the preview thumbnail; revoked on remove/reset. */
  previewUrl: string;
  status: UploadStatus;
  /** Durable blob URL, set once the direct-to-Blob client upload resolves. */
  blobUrl?: string;
  /** Upload failure reason, shown inline with a per-file retry. */
  error?: string;
  width?: number;
  height?: number;
  /** Optional per-image caption hint (product entries only). */
  hint: string;
};

/** A file rejected by client validation, surfaced inline by the uploader. */
export type Rejection = { name: string; reason: string };

/** Batch params held in the store (mirrors `Job.params`, architecture §7.1). */
export type BatchParams = {
  aspectRatio: AspectRatio;
  brief: string;
};

/**
 * Typed `POST /api/jobs` request body (architecture §7.2). Defined here (not in
 * `lib/types.ts`, which is backend-owned) as the FE→BE request contract; Task 7
 * submits it. `perImageHints` is keyed by product `blobUrl` (== productImageUrl).
 */
export type CreateJobRequest = {
  productImageUrls: string[];
  referenceImageUrls: string[];
  params: {
    aspectRatio: AspectRatio;
    brief?: string;
    perImageHints?: Record<string, string>;
  };
};

/* ──────────────────────────────────────────────────────────────────────────
 * Batch read-model (component C5, frontend)
 *
 * The SSE-driven grid state. It is updated ONLY from SSE events + the job
 * snapshot — the server is the authority (product-flow §0 single-writer). The
 * one exception is OPTIMISTIC placeholders created on Generate (one per product
 * image), which the first snapshot/events reconcile into the real itemIds.
 * ────────────────────────────────────────────────────────────────────────── */

/** Per-tile status (UI vocabulary). Maps from the server `ItemStatus`. */
export type TileStatus = "queued" | "generating" | "done" | "failed";

/** Connection lifecycle, including the pre-launch `idle` baseline. */
export type BatchConnection = StreamConnectionState | "idle";

/** One tile's read-model: keyed by `itemId` once reconciled (product-flow §3). */
export type BatchItem = {
  /** Server itemId; undefined for an optimistic placeholder until reconciled. */
  itemId?: string;
  /** Durable product blobUrl (== server `productImageUrl`) — the stable join key. */
  productImageUrl: string;
  /** Local object URL for the placeholder thumbnail (queued/generating only). */
  previewUrl?: string;
  status: TileStatus;
  result?: { imageUrl: string; providerId: string; usedImageReference: boolean };
  error?: { code: string; message: string; lastProviderId: string };
};

/** The whole-batch read-model behind the grid. */
export type BatchState = {
  jobId?: string;
  status: BatchConnection;
  /** Output ratio captured at launch (tiles keep a fixed aspect box, NFR-7). */
  aspectRatio: AspectRatio;
  items: BatchItem[];
  total: number;
  done: number;
  failed: number;
  /** `POST /api/jobs` failure message, shown after an optimistic rollback (§5j). */
  launchError?: string;
};

export type BatchStore = {
  entries: UploadEntry[];
  params: BatchParams;
  batch: BatchState;
  /** True while the bundled example batch is being fetched + uploaded (pre-generate). */
  exampleLoading: boolean;

  /** Validate + add + eagerly upload files for a bucket; returns rejections. */
  addFiles: (files: File[], kind: UploadKind) => Promise<{ rejected: Rejection[] }>;
  /** Remove one entry and revoke its preview object URL. */
  removeEntry: (id: string) => void;
  /** Re-run the upload for an errored entry. */
  retryUpload: (id: string) => Promise<void>;
  /** Set the per-image caption hint for a product entry. */
  setEntryHint: (id: string, hint: string) => void;

  setAspectRatio: (aspectRatio: AspectRatio) => void;
  setBrief: (brief: string) => void;

  /** Clear everything (revokes all preview URLs). */
  reset: () => void;

  /**
   * Assemble the `POST /api/jobs` payload from uploaded entries, or `null` if
   * the selection is not ready to generate. Task 7 calls this on Generate.
   */
  buildCreateJobRequest: () => CreateJobRequest | null;

  /**
   * Generate: build the request, render N optimistic placeholders, `createJob`,
   * then open the SSE stream. On a launch failure it rolls the grid back (§5j).
   */
  generate: () => Promise<void>;
  /**
   * One-click demo: fetch the bundled example reference + product images and run
   * them through the SAME validate → upload → generate path a manual batch uses
   * (so it exercises Blob upload, SSRF checks, and the real orchestrator), then
   * stream. Best-effort: surfaces a launch error on any failure.
   */
  runExample: () => Promise<void>;
  /** Targeted retry of one failed tile; reopens a settled stream if needed (§5d). */
  retry: (itemId: string) => Promise<void>;
  /** Tear down the stream and clear the grid (uploads/params are kept). */
  resetBatch: () => void;

  /** Internal (SSE client → store): merge a `Job` snapshot, reconciling itemIds. */
  _mergeSnapshot: (job: Job) => void;
  /** Internal (SSE client → store): apply one named SSE event. */
  _applyEvent: <K extends SseEventName>(name: K, data: SseEventMap[K]) => void;
  /** Internal (SSE client → store): reflect the connection lifecycle. */
  _setConnection: (state: StreamConnectionState) => void;

  /** Internal: drive one entry's upload, patching status/blobUrl/error. */
  _upload: (id: string) => Promise<void>;
};

const INITIAL_PARAMS: BatchParams = { aspectRatio: "1:1", brief: "" };

/** Pure selector: product entries. */
export function selectProducts(entries: UploadEntry[]): UploadEntry[] {
  return entries.filter((e) => e.kind === "product");
}

/** Pure selector: reference entries. */
export function selectReferences(entries: UploadEntry[]): UploadEntry[] {
  return entries.filter((e) => e.kind === "reference");
}

/**
 * Generate is enabled iff ≥1 product image and 1–2 reference images are present
 * AND every selected file has finished uploading (no in-flight, no errored)
 * — product-flow §2.6. The task's floor ("≥1 product + ≥1 reference present")
 * is the necessary part of this stricter, correct condition.
 */
export function isReadyToGenerate(entries: UploadEntry[]): boolean {
  if (entries.length === 0) return false;
  if (!entries.every((e) => e.status === "uploaded" && e.blobUrl)) return false;
  const products = selectProducts(entries).length;
  const references = selectReferences(entries).length;
  return (
    products >= 1 &&
    products <= MAX_PRODUCT_IMAGES &&
    references >= 1 &&
    references <= MAX_REFERENCE_IMAGES
  );
}

/** The bundled example assets served from `public/examples/` (kind preserved). */
const EXAMPLE_ASSETS: ReadonlyArray<{ name: string; kind: UploadKind }> = [
  { name: "product-1.jpg", kind: "product" },
  { name: "product-2.jpg", kind: "product" },
  { name: "product-3.jpg", kind: "product" },
  { name: "reference.jpg", kind: "reference" },
];

/**
 * Poll the store until every selected file has finished uploading (ready), or one
 * errors, or the timeout elapses. Used by `runExample` to wait for the eager
 * uploads kicked off by `addFiles` before submitting the job.
 */
async function awaitUploadsSettled(
  getState: () => BatchStore,
  timeoutMs = 60_000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const entries = getState().entries;
    if (entries.length > 0 && entries.some((e) => e.status === "error")) return false;
    if (isReadyToGenerate(entries)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** The live SSE stream controller (module-level: one batch in view at a time). */
let streamController: JobStreamController | null = null;
/** itemId → index into `batch.items`, rebuilt on each snapshot reconcile. */
const itemIndexById = new Map<string, number>();

const EMPTY_BATCH: BatchState = {
  status: "idle",
  aspectRatio: "1:1",
  items: [],
  total: 0,
  done: 0,
  failed: 0,
};

/** Map a server `ItemStatus` to the tile's UI status. */
function mapItemStatus(status: ItemStatus): TileStatus {
  switch (status) {
    case "running":
      return "generating";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}

/** Merge one authoritative server `Item` into a tile (never downgrades a result). */
function mergeServerItem(tile: BatchItem, srv: Item): BatchItem {
  const base: BatchItem = { ...tile, itemId: srv.id };
  if (srv.result) {
    return { ...base, status: "done", result: { ...srv.result }, error: undefined };
  }
  if (srv.status === "failed" && srv.error) {
    return { ...base, status: "failed", error: { ...srv.error } };
  }
  if (tile.status === "done") return base; // keep an already-shown result
  return { ...base, status: mapItemStatus(srv.status) };
}

/** Apply one item-scoped SSE event to a tile (idempotent; never loses a result). */
function reduceItemEvent(
  tile: BatchItem,
  name: "item.status" | "item.result" | "item.error",
  data: SseEventMap["item.status"] | SseEventMap["item.result"] | SseEventMap["item.error"],
): BatchItem {
  if (name === "item.result") {
    const r = data as SseEventMap["item.result"];
    return {
      ...tile,
      status: "done",
      result: {
        imageUrl: r.imageUrl,
        providerId: r.providerId,
        usedImageReference: r.usedImageReference,
      },
      error: undefined,
    };
  }
  // Both item.status and item.error must never clobber an already-shown result.
  if (tile.status === "done") return tile;
  if (name === "item.error") {
    const e = data as SseEventMap["item.error"];
    return {
      ...tile,
      status: "failed",
      error: { code: e.code, message: e.message, lastProviderId: e.lastProviderId },
    };
  }
  const s = data as SseEventMap["item.status"];
  if (s.status === "queued") return { ...tile, status: "queued", error: undefined };
  if (s.status === "running") return { ...tile, status: "generating", error: undefined };
  return tile;
}

/** Count terminal items in a snapshot for the global `done / failed` indicator. */
function countTerminals(items: Item[]): { done: number; failed: number } {
  let done = 0;
  let failed = 0;
  for (const it of items) {
    if (it.status === "succeeded") done += 1;
    else if (it.status === "failed") failed += 1;
  }
  return { done, failed };
}

export const useBatchStore = create<BatchStore>()((set, get) => ({
  entries: [],
  params: INITIAL_PARAMS,
  batch: { ...EMPTY_BATCH },
  exampleLoading: false,

  addFiles: async (files, kind) => {
    const cap = kind === "product" ? MAX_PRODUCT_IMAGES : MAX_REFERENCE_IMAGES;
    const rejected: Rejection[] = [];

    for (const file of files) {
      // Enforce the N / R cap against the live count (sequential => no race).
      const currentCount = get().entries.filter((e) => e.kind === kind).length;
      if (currentCount >= cap) {
        rejected.push({
          name: file.name,
          reason:
            kind === "product"
              ? `limit reached (max ${cap} product images)`
              : `limit reached (max ${cap} reference images)`,
        });
        continue;
      }

      const result = await validateImageFile(file);
      if (!result.ok) {
        rejected.push({ name: file.name, reason: result.reason });
        continue;
      }

      const entry: UploadEntry = {
        id: crypto.randomUUID(),
        kind,
        file,
        previewUrl: URL.createObjectURL(file),
        status: "uploading",
        width: result.width,
        height: result.height,
        hint: "",
      };
      set((s) => ({ entries: [...s.entries, entry] }));
      void get()._upload(entry.id);
    }

    return { rejected };
  },

  removeEntry: (id) => {
    const entry = get().entries.find((e) => e.id === id);
    if (entry) URL.revokeObjectURL(entry.previewUrl);
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  },

  retryUpload: async (id) => {
    await get()._upload(id);
  },

  setEntryHint: (id, hint) => {
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, hint } : e)),
    }));
  },

  setAspectRatio: (aspectRatio) => {
    set((s) => ({ params: { ...s.params, aspectRatio } }));
  },

  setBrief: (brief) => {
    set((s) => ({ params: { ...s.params, brief } }));
  },

  reset: () => {
    streamController?.close();
    streamController = null;
    itemIndexById.clear();
    for (const e of get().entries) URL.revokeObjectURL(e.previewUrl);
    set({ entries: [], params: INITIAL_PARAMS, batch: { ...EMPTY_BATCH } });
  },

  buildCreateJobRequest: () => {
    const { entries, params } = get();
    if (!isReadyToGenerate(entries)) return null;

    const productImageUrls: string[] = [];
    const perImageHints: Record<string, string> = {};
    for (const e of selectProducts(entries)) {
      if (!e.blobUrl) continue;
      productImageUrls.push(e.blobUrl);
      const hint = e.hint.trim();
      if (hint) perImageHints[e.blobUrl] = hint;
    }

    const referenceImageUrls: string[] = [];
    for (const e of selectReferences(entries)) {
      if (e.blobUrl) referenceImageUrls.push(e.blobUrl);
    }

    const jobParams: CreateJobRequest["params"] = { aspectRatio: params.aspectRatio };
    const brief = params.brief.trim();
    if (brief) jobParams.brief = brief;
    if (Object.keys(perImageHints).length > 0) jobParams.perImageHints = perImageHints;

    return { productImageUrls, referenceImageUrls, params: jobParams };
  },

  generate: async () => {
    const request = get().buildCreateJobRequest();
    if (!request) return;

    // Optimistic placeholders, one per product URL in submitted order. Their
    // preview thumbnails come from the matching upload entries.
    const previewByUrl = new Map<string, string>();
    for (const e of get().entries) {
      if (e.blobUrl) previewByUrl.set(e.blobUrl, e.previewUrl);
    }
    const items: BatchItem[] = request.productImageUrls.map((url) => ({
      productImageUrl: url,
      previewUrl: previewByUrl.get(url),
      status: "queued",
    }));

    // Drop any prior stream/grid before seating the new optimistic one.
    streamController?.close();
    streamController = null;
    itemIndexById.clear();
    set({
      batch: {
        status: "connecting",
        aspectRatio: get().params.aspectRatio,
        items,
        total: items.length,
        done: 0,
        failed: 0,
      },
    });

    let jobId: string;
    try {
      const created = await createJob(request, crypto.randomUUID());
      jobId = created.jobId;
    } catch (err) {
      // No jobId ⇒ roll the optimistic grid back; uploads/params stay intact (§5j).
      const message =
        err instanceof JobApiError ? err.message : "Couldn't start the batch. Try again.";
      set({ batch: { ...EMPTY_BATCH, launchError: message } });
      return;
    }

    set((s) => ({ batch: { ...s.batch, jobId } }));

    streamController = openJobStream(jobId, {
      onSnapshot: (job) => {
        get()._mergeSnapshot(job);
      },
      onEvent: (name, data) => {
        get()._applyEvent(name, data);
      },
      onConnection: (state) => {
        get()._setConnection(state);
      },
    });
  },

  runExample: async () => {
    if (get().exampleLoading) return;
    set({ exampleLoading: true });
    const fail = () =>
      set({
        batch: {
          ...EMPTY_BATCH,
          launchError: "Couldn't load the example batch — please try again.",
        },
      });
    try {
      // Start clean, then fetch the bundled assets and feed them through the very
      // same path a manual upload uses (validate → eager upload → generate).
      get().reset();
      const loaded: Array<{ file: File; kind: UploadKind }> = [];
      for (const { name, kind } of EXAMPLE_ASSETS) {
        const res = await fetch(`/examples/${name}`);
        if (!res.ok) throw new Error(`example asset ${name} → HTTP ${res.status}`);
        const blob = await res.blob();
        loaded.push({ file: new File([blob], name, { type: "image/jpeg" }), kind });
      }
      await get().addFiles(
        loaded.filter((f) => f.kind === "product").map((f) => f.file),
        "product",
      );
      await get().addFiles(
        loaded.filter((f) => f.kind === "reference").map((f) => f.file),
        "reference",
      );
      if (!(await awaitUploadsSettled(get))) {
        fail();
        return;
      }
      await get().generate();
    } catch {
      fail();
    } finally {
      set({ exampleLoading: false });
    }
  },

  retry: async (itemId) => {
    const { jobId } = get().batch;
    if (!jobId) return;

    const idx = itemIndexById.get(itemId);
    const prevError = idx !== undefined ? get().batch.items[idx]?.error : undefined;

    // Optimistically flip the tile back to queued (clears the error) for instant feedback.
    get()._applyEvent("item.status", { itemId, status: "queued" });

    try {
      await retryItem(jobId, itemId);
    } catch (err) {
      const message =
        err instanceof JobApiError && err.status === 404
          ? "This batch is no longer available — start a new one."
          : "Retry failed — please try again.";
      get()._applyEvent("item.error", {
        itemId,
        code: prevError?.code ?? "retry_failed",
        message,
        lastProviderId: prevError?.lastProviderId ?? "",
      });
      return;
    }

    // If the job had already settled (job.done received), reopen the stream so the
    // re-driven item's live events + re-emitted job.done arrive (product-flow §2.12).
    if (get().batch.status === "done") streamController?.reopen();
  },

  resetBatch: () => {
    streamController?.close();
    streamController = null;
    itemIndexById.clear();
    set({ batch: { ...EMPTY_BATCH } });
  },

  _mergeSnapshot: (job) => {
    const state = get();
    const items = state.batch.items.slice();

    const firstIndexByUrl = new Map<string, number>();
    items.forEach((it, i) => {
      if (!firstIndexByUrl.has(it.productImageUrl)) firstIndexByUrl.set(it.productImageUrl, i);
    });

    // Reconcile by submission order (the create route preserves it); fall back to
    // a productImageUrl match if the orders ever diverge.
    itemIndexById.clear();
    job.items.forEach((srv, i) => {
      let idx: number;
      if (i < items.length && items[i].productImageUrl === srv.productImageUrl) {
        idx = i;
      } else {
        idx = firstIndexByUrl.get(srv.productImageUrl) ?? (i < items.length ? i : -1);
      }
      if (idx < 0 || idx >= items.length) return;
      itemIndexById.set(srv.id, idx);
      items[idx] = mergeServerItem(items[idx], srv);
    });

    const { done, failed } = countTerminals(job.items);
    set({ batch: { ...state.batch, items, total: job.items.length, done, failed } });
  },

  _applyEvent: (name, data) => {
    if (name === "job.progress") {
      const p = data as SseEventMap["job.progress"];
      const state = get();
      set({ batch: { ...state.batch, done: p.done, failed: p.failed, total: p.total } });
      return;
    }
    if (name === "job.done") {
      // The terminal UI is driven by the connection transition to "done".
      return;
    }

    const itemName = name as "item.status" | "item.result" | "item.error";
    const ev = data as
      | SseEventMap["item.status"]
      | SseEventMap["item.result"]
      | SseEventMap["item.error"];
    const idx = itemIndexById.get(ev.itemId);
    if (idx === undefined) return; // event for an unreconciled item — ignore

    const state = get();
    const tile = state.batch.items[idx];
    if (!tile) return;
    const next = reduceItemEvent(tile, itemName, ev);
    if (next === tile) return;
    const items = state.batch.items.slice();
    items[idx] = next;
    set({ batch: { ...state.batch, items } });
  },

  _setConnection: (state) => {
    const s = get();
    set({ batch: { ...s.batch, status: state } });
  },

  _upload: async (id) => {
    set((s) => ({
      entries: s.entries.map((e) =>
        e.id === id ? { ...e, status: "uploading", error: undefined } : e,
      ),
    }));

    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;

    try {
      const blobUrl = await uploadFile(entry.file, entry.kind);
      set((s) => ({
        entries: s.entries.map((e) =>
          e.id === id ? { ...e, status: "uploaded", blobUrl, error: undefined } : e,
        ),
      }));
    } catch (err) {
      const message = err instanceof UploadError ? err.message : "Upload failed.";
      set((s) => ({
        entries: s.entries.map((e) =>
          e.id === id ? { ...e, status: "error", error: message } : e,
        ),
      }));
    }
  },
}));
