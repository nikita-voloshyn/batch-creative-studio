---
component: FailoverEngine
source: lib/orchestrator/failover.ts
agent: backend
updated: 2026-06-28
---

# FailoverEngine

## Purpose
Turns the single-provider retry path into an ordered failover loop over an injected `ImageProvider[]` chain. For each provider it runs the per-provider retry path and advances/stops based on the 3-way retry outcome, yielding a terminal chain-level result. It consumes only the `ImageProvider` interface and injected callbacks, so it is separately testable and never names the registry, rate limiter, or any concrete adapter.

## Public Interface
- `runFailover<T>(chain: readonly ImageProvider[], hooks: FailoverHooks<T>): Promise<FailoverOutcome<T>>` — runs the ordered chain loop and returns its terminal outcome.
- `type FailoverHooks<T>` — `{ shouldPreSwitch(provider) => boolean; runProvider(provider) => Promise<RetryOutcome<T>>; onAdvance?(transition) => void }`.
- `type FailoverOutcome<T>` — `{status:"success"; value}` | `{status:"failed"; reason:"exhausted"|"fail_item"; error; lastProviderId}` | `{status:"aborted"; error; lastProviderId}`.
- `type FailoverTransition` — `{ from: ImageProvider; to: ImageProvider | undefined; reason: FailoverReason }`.
- `type FailoverReason` — `"quota_pre_switch" | "exhausted"`.

## Inputs and Outputs
- Iterates the chain in order. Per provider: if not the last AND `shouldPreSwitch(provider)` is true, fires `onAdvance({reason:"quota_pre_switch"})` and skips. Otherwise calls `runProvider(provider)` and acts on the `RetryOutcome`:
  - `success` → returns `{status:"success", value}`.
  - `fail_item` (content_policy / invalid_input) → STOP; returns `{status:"failed", reason:"fail_item"}`.
  - `aborted` (job interrupt) → STOP; returns `{status:"aborted"}`.
  - `advance` (retries exhausted OR auth/quota_exhausted) → move to next; if none remains returns `{status:"failed", reason:"exhausted"}`.
- Empty chain → defensive `{status:"failed", reason:"exhausted"}` with an empty `lastProviderId`.
- `lastProviderId` on any failure names the last provider actually attempted.

## Dependencies
- `lib/orchestrator/retry.ts` — consumes its `RetryOutcome<T>` type as the per-provider result.
- `lib/providers` — `ImageProvider` interface and the neutral `ProviderError`.

## Key Decisions
- The LAST provider in the chain is never pre-switched away — it is the item's last hope, and a genuinely exhausted provider is still caught at runtime via a `quota_exhausted` advance. The in-memory daily counter is best-effort only.
- The engine is deliberately decoupled: composition root wires `shouldPreSwitch`/`runProvider` to the registry, rate limiter, and result store, so this file stays a pure ordering policy.
- `fail_item` and `aborted` short-circuit the chain because no other provider can help (content policy / invalid input) or because a shutdown must never trigger failover.

## Known Limitations
- Pre-switch decision relies on a best-effort in-memory daily counter, not a durable cross-instance quota.
- Assumes a non-empty chain in normal operation (the composition root fails the whole job on an empty chain); the empty-chain branch is purely defensive.
