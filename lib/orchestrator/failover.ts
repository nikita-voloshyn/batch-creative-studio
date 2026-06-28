/**
 * Multi-provider failover engine (component C-failover, backend — BE).
 *
 * Turns the single-provider retry path into the ordered failover loop over an
 * injected `ImageProvider[]` (architecture §5 / §5.2, product-flow §3 (5) / §5b).
 * It is the Task 9 realization of the seam the orchestrator left open: for each
 * provider in the chain it runs the per-provider retry path (a `runProvider`
 * callback that internally drives `runWithRetry` + `classifyKind`) and advances
 * on the 3-way `RetryOutcome`:
 *
 *   success    → done (the winning result is returned).
 *   advance    → retries exhausted OR a provider-hopeless fatal (auth /
 *                quota_exhausted). Move to the NEXT provider; once the chain is
 *                exhausted the item fails with `all_providers_exhausted`.
 *   fail_item  → content_policy / invalid_input: STOP. No provider helps, so the
 *                item fails immediately with the underlying error kind.
 *   aborted    → job-level interrupt: STOP (never failover on a shutdown).
 *
 * Quota pre-switch (architecture §5.4, product-flow §5g): before running a
 * provider the engine consults `shouldPreSwitch`. A provider at/over its daily
 * soft threshold is skipped pre-emptively in favor of the next provider — BUT the
 * LAST provider in the chain is never pre-switched away (it is the item's last
 * hope; the in-memory daily counter is best-effort and a genuinely exhausted
 * provider is still caught at runtime by a `quota_exhausted` advance).
 *
 * BOUNDARY (load-bearing, architecture §4): this engine consumes ONLY the
 * `ImageProvider` interface, the neutral `ProviderError`, and the injected
 * callbacks. It never names the registry, the rate limiter, the result store, or
 * a concrete adapter — the composition root (`orchestrator.ts`) wires those into
 * `shouldPreSwitch` / `runProvider`, keeping the engine separately testable
 * (Task 10 exercises it with the fake provider).
 */

import type { RetryOutcome } from "@/lib/orchestrator/retry";
import type { ImageProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers";

/** Reason the engine moved off a provider (for the `failover` log line, §9). */
export type FailoverReason = "quota_pre_switch" | "exhausted";

/** One from→to hop in the chain, surfaced to the caller for structured logging. */
export type FailoverTransition = {
  from: ImageProvider;
  /** The provider being advanced to, or `undefined` if none remains. */
  to: ImageProvider | undefined;
  reason: FailoverReason;
};

/** Injected behaviors — the composition root binds these to backend singletons. */
export type FailoverHooks<T> = {
  /**
   * True ⇒ this provider is at/over its daily soft quota and should be skipped
   * pre-emptively (product-flow §5g). Never consulted for the last provider.
   */
  shouldPreSwitch: (provider: ImageProvider) => boolean;
  /** Run the per-provider retry path for one provider (drives `runWithRetry`). */
  runProvider: (provider: ImageProvider) => Promise<RetryOutcome<T>>;
  /** Notified on every chain hop (quota pre-switch or post-exhaustion advance). */
  onAdvance?: (transition: FailoverTransition) => void;
};

/** Terminal outcome of the whole failover loop over the chain. */
export type FailoverOutcome<T> =
  | { status: "success"; value: T }
  | {
      status: "failed";
      /** `exhausted` = whole chain tried; `fail_item` = no provider can help. */
      reason: "exhausted" | "fail_item";
      error: ProviderError;
      /** The last provider actually attempted (for `item.error.lastProviderId`). */
      lastProviderId: string;
    }
  | { status: "aborted"; error: ProviderError; lastProviderId: string };

/**
 * Run the ordered failover loop over `chain`. The chain is assumed non-empty (the
 * composition root fails the whole job on an empty chain — architecture §4 /
 * §5.1); an empty chain returns a defensive `exhausted` failure.
 */
export async function runFailover<T>(
  chain: readonly ImageProvider[],
  hooks: FailoverHooks<T>,
): Promise<FailoverOutcome<T>> {
  if (chain.length === 0) {
    return {
      status: "failed",
      reason: "exhausted",
      error: new ProviderError("server", "", "No providers configured."),
      lastProviderId: "",
    };
  }

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    const next = chain[i + 1];
    const hasNext = next !== undefined;

    // Quota pre-switch: skip a near-quota provider, but never the last hope.
    if (hasNext && hooks.shouldPreSwitch(provider)) {
      hooks.onAdvance?.({ from: provider, to: next, reason: "quota_pre_switch" });
      continue;
    }

    const outcome = await hooks.runProvider(provider);
    switch (outcome.status) {
      case "success":
        return { status: "success", value: outcome.value };
      case "fail_item":
        // content_policy / invalid_input → no provider helps; stop now.
        return {
          status: "failed",
          reason: "fail_item",
          error: outcome.error,
          lastProviderId: provider.id,
        };
      case "aborted":
        // Job-level interrupt → never failover.
        return { status: "aborted", error: outcome.error, lastProviderId: provider.id };
      case "advance":
        if (hasNext) {
          hooks.onAdvance?.({ from: provider, to: next, reason: "exhausted" });
          continue;
        }
        // Last provider exhausted → the item has run out of options.
        return {
          status: "failed",
          reason: "exhausted",
          error: outcome.error,
          lastProviderId: provider.id,
        };
    }
  }

  // Unreachable for a non-empty chain: the last provider is never pre-switched
  // away, so the loop always returns from within. Defensive fallback.
  const last = chain[chain.length - 1];
  return {
    status: "failed",
    reason: "exhausted",
    error: new ProviderError("server", last.id, "Failover chain produced no attempt."),
    lastProviderId: last.id,
  };
}
