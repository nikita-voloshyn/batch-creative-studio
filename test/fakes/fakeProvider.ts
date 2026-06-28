/**
 * Controllable, deterministic fake `ImageProvider` (testing agent, Task 10).
 *
 * Drives the reliability core (retry engine, failover engine, orchestrator)
 * without hitting any real provider API. Each `generate()` call consumes the next
 * scripted behavior, so a per-attempt failure sequence ("429 twice then succeed")
 * is expressed as a plain array. When the script runs out, `fallback` (default:
 * success) is used for all further calls. Every call is recorded on `calls` for
 * assertions (which input was sent, whether the signal had aborted).
 *
 * Behaviors mirror the real provider surface the engine must tolerate:
 *  - `success`     → returns bytes + `usedImageReference` + `contentType`;
 *  - `error`       → throws a neutral `ProviderError` of a given `kind`
 *                    (rate_limit | server | timeout | unavailable | auth |
 *                     quota_exhausted | content_policy | invalid_input), with an
 *                    optional `httpStatus` / `retryAfterMs`;
 *  - `abort`       → throws a DOMException `AbortError` (a raw provider abort /
 *                    timeout the retry engine coerces to a retryable timeout);
 *  - `empty`       → returns HTTP-200-equivalent with NO image bytes (the
 *                    orchestrator's result-validation rejects this as retryable,
 *                    product-flow §5k).
 */
import { ProviderError, type ProviderErrorKind } from "@/lib/providers/errors";
import type { GenerateInput, GenerateResult, ImageProvider } from "@/lib/providers/types";

/** Smallest byte fixtures the result store / adapters can sniff by magic bytes. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
export const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

export type FakeBehavior =
  | {
      type: "success";
      usedImageReference?: boolean;
      contentType?: string;
      bytes?: Uint8Array | string;
    }
  | {
      type: "error";
      kind: ProviderErrorKind;
      httpStatus?: number;
      retryAfterMs?: number;
      message?: string;
    }
  | { type: "abort" }
  | { type: "empty" };

export type FakeProviderOptions = {
  id?: string;
  supportsImageReference?: boolean;
  /** One behavior per `generate()` call (attempt). Consumed in order. */
  script?: FakeBehavior[];
  /** Used once the script is exhausted (default: a plain success). */
  fallback?: FakeBehavior;
};

/** One recorded `generate()` invocation. */
export type FakeCall = {
  input: GenerateInput;
  /** Whether the per-attempt signal had already aborted when the call ran. */
  abortedAtEntry: boolean;
};

export type FakeProvider = ImageProvider & {
  readonly calls: FakeCall[];
  /** Number of `generate()` calls made so far. */
  callCount(): number;
};

/** Build a controllable fake provider. */
export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const id = options.id ?? "fake";
  const supportsImageReference = options.supportsImageReference ?? true;
  const script = [...(options.script ?? [])];
  const fallback: FakeBehavior = options.fallback ?? { type: "success" };
  const calls: FakeCall[] = [];

  function nextBehavior(): FakeBehavior {
    return script.length > 0 ? (script.shift() as FakeBehavior) : fallback;
  }

  return {
    id,
    supportsImageReference,
    calls,
    callCount: () => calls.length,

    async generate(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult> {
      calls.push({ input, abortedAtEntry: signal?.aborted ?? false });
      // Yield once so behavior is genuinely async (mirrors a real network call).
      await Promise.resolve();
      const behavior = nextBehavior();

      switch (behavior.type) {
        case "error":
          throw new ProviderError(
            behavior.kind,
            id,
            behavior.message ?? `fake ${behavior.kind}`,
            behavior.httpStatus,
            behavior.retryAfterMs,
          );
        case "abort":
          throw new DOMException("Simulated provider abort/timeout.", "AbortError");
        case "empty":
          return {
            imageBytes: new Uint8Array(0),
            providerId: id,
            usedImageReference: supportsImageReference,
            meta: { latencyMs: 1, model: `${id}-model` },
          };
        case "success":
          return {
            imageBytes: behavior.bytes ?? PNG_BYTES,
            providerId: id,
            usedImageReference: behavior.usedImageReference ?? supportsImageReference,
            contentType: behavior.contentType ?? "image/png",
            meta: { latencyMs: 1, model: `${id}-model` },
          };
      }
    },
  };
}
