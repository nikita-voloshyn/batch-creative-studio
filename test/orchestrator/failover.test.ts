/**
 * Failover engine specifications (testing agent, Task 10).
 *
 * Drives `runFailover` with a fixed fake chain and INJECTED hooks (`runProvider`
 * returns a raw `RetryOutcome`; `shouldPreSwitch` and `onAdvance` are stubs), so
 * the chain-advancement policy is exercised in isolation from the retry engine.
 * Maps to product-flow §5b (advance), §5c (prompt-only surfaces), §5d
 * (all-exhausted), §5i (content-policy stops), abort (never failover), and §5g
 * (quota pre-switch — skip near-quota, never the last).
 */
import { describe, expect, test } from "vitest";
import {
  type FailoverHooks,
  type FailoverTransition,
  runFailover,
} from "@/lib/orchestrator/failover";
import type { RetryOutcome } from "@/lib/orchestrator/retry";
import { ProviderError } from "@/lib/providers/errors";
import type { ImageProvider } from "@/lib/providers/types";

type Result = { imageUrl: string; providerId: string; usedImageReference: boolean };

/** A minimal `ImageProvider` (only id + capability are read by the engine). */
function provider(id: string, supportsImageReference = true): ImageProvider {
  return {
    id,
    supportsImageReference,
    generate: async () => {
      throw new Error("not called — runProvider is injected");
    },
  };
}

const ok = (id: string, usedImageReference = true): RetryOutcome<Result> => ({
  status: "success",
  value: { imageUrl: `results/${id}.png`, providerId: id, usedImageReference },
});
const advance = (id: string, kind: ProviderError["kind"] = "server"): RetryOutcome<Result> => ({
  status: "advance",
  error: new ProviderError(kind, id, `${id} exhausted`),
});
const failItem = (id: string): RetryOutcome<Result> => ({
  status: "fail_item",
  error: new ProviderError("content_policy", id, "blocked"),
});
const aborted = (id: string): RetryOutcome<Result> => ({
  status: "aborted",
  error: new ProviderError("timeout", id, "job aborted"),
});

/** Build hooks whose `runProvider` returns a scripted outcome per provider id. */
function hooksFor(
  outcomes: Record<string, RetryOutcome<Result>>,
  opts: { preSwitch?: (id: string) => boolean } = {},
): FailoverHooks<Result> & {
  runCalls: string[];
  transitions: FailoverTransition[];
} {
  const runCalls: string[] = [];
  const transitions: FailoverTransition[] = [];
  return {
    runCalls,
    transitions,
    shouldPreSwitch: (p) => opts.preSwitch?.(p.id) ?? false,
    runProvider: async (p) => {
      runCalls.push(p.id);
      const outcome = outcomes[p.id];
      if (!outcome) throw new Error(`no scripted outcome for ${p.id}`);
      return outcome;
    },
    onAdvance: (t) => transitions.push(t),
  };
}

describe("runFailover — §5b provider exhausted → advance → success", () => {
  test("advances to the next provider after the first is exhausted, then succeeds", async () => {
    const chain = [provider("gemini"), provider("cloudflare")];
    const hooks = hooksFor({ gemini: advance("gemini"), cloudflare: ok("cloudflare") });

    const result = await runFailover<Result>(chain, hooks);

    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.value.providerId).toBe("cloudflare");
    expect(hooks.runCalls).toEqual(["gemini", "cloudflare"]);
    expect(hooks.transitions).toHaveLength(1);
    expect(hooks.transitions[0]).toMatchObject({ reason: "exhausted" });
    expect(hooks.transitions[0].from.id).toBe("gemini");
    expect(hooks.transitions[0].to?.id).toBe("cloudflare");
  });
});

describe("runFailover — §5c prompt-only degradation", () => {
  test("surfaces usedImageReference:false from the winning fallback provider", async () => {
    const chain = [provider("gemini"), provider("cloudflare", false)];
    const hooks = hooksFor({
      gemini: advance("gemini"),
      cloudflare: ok("cloudflare", false),
    });

    const result = await runFailover<Result>(chain, hooks);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.value.usedImageReference).toBe(false);
      expect(result.value.providerId).toBe("cloudflare");
    }
  });
});

describe("runFailover — §5d all providers exhausted", () => {
  test("fails with reason=exhausted and the last provider id when the chain is drained", async () => {
    const chain = [provider("gemini"), provider("cloudflare"), provider("replicate")];
    const hooks = hooksFor({
      gemini: advance("gemini"),
      cloudflare: advance("cloudflare"),
      replicate: advance("replicate", "quota_exhausted"),
    });

    const result = await runFailover<Result>(chain, hooks);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("exhausted");
      expect(result.lastProviderId).toBe("replicate");
      expect(result.error.kind).toBe("quota_exhausted");
    }
    expect(hooks.runCalls).toEqual(["gemini", "cloudflare", "replicate"]);
  });
});

describe("runFailover — §5i content-policy stops without failover", () => {
  test("fail_item halts the chain immediately and never advances", async () => {
    const chain = [provider("gemini"), provider("cloudflare")];
    const hooks = hooksFor({ gemini: failItem("gemini"), cloudflare: ok("cloudflare") });

    const result = await runFailover<Result>(chain, hooks);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("fail_item");
      expect(result.lastProviderId).toBe("gemini");
      expect(result.error.kind).toBe("content_policy");
    }
    expect(hooks.runCalls).toEqual(["gemini"]); // cloudflare never tried
    expect(hooks.transitions).toHaveLength(0);
  });
});

describe("runFailover — aborted never fails over", () => {
  test("an aborted outcome stops the chain without trying the next provider", async () => {
    const chain = [provider("gemini"), provider("cloudflare")];
    const hooks = hooksFor({ gemini: aborted("gemini"), cloudflare: ok("cloudflare") });

    const result = await runFailover<Result>(chain, hooks);

    expect(result.status).toBe("aborted");
    if (result.status === "aborted") expect(result.lastProviderId).toBe("gemini");
    expect(hooks.runCalls).toEqual(["gemini"]);
    expect(hooks.transitions).toHaveLength(0);
  });
});

describe("runFailover — §5g quota pre-switch", () => {
  test("skips a near-quota provider in favor of the next, never running it", async () => {
    const chain = [provider("gemini"), provider("cloudflare")];
    const hooks = hooksFor(
      { gemini: ok("gemini"), cloudflare: ok("cloudflare") },
      { preSwitch: (id) => id === "gemini" },
    );

    const result = await runFailover<Result>(chain, hooks);

    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.value.providerId).toBe("cloudflare");
    expect(hooks.runCalls).toEqual(["cloudflare"]); // gemini skipped pre-emptively
    expect(hooks.transitions[0]).toMatchObject({ reason: "quota_pre_switch" });
  });

  test("NEVER pre-switches away from the last provider (its last hope)", async () => {
    const chain = [provider("gemini"), provider("cloudflare")];
    // Both report near-quota, but the last (cloudflare) must still be attempted.
    const hooks = hooksFor(
      { gemini: ok("gemini"), cloudflare: ok("cloudflare") },
      { preSwitch: () => true },
    );

    const result = await runFailover<Result>(chain, hooks);

    expect(result.status).toBe("success");
    expect(hooks.runCalls).toEqual(["cloudflare"]); // gemini skipped, cloudflare run
  });

  test("a single near-quota provider chain still runs it (last = never skipped)", async () => {
    const chain = [provider("gemini")];
    const hooks = hooksFor({ gemini: ok("gemini") }, { preSwitch: () => true });

    const result = await runFailover<Result>(chain, hooks);

    expect(result.status).toBe("success");
    expect(hooks.runCalls).toEqual(["gemini"]);
    expect(hooks.transitions).toHaveLength(0);
  });
});

describe("runFailover — defensive empty chain", () => {
  test("returns an exhausted failure for an empty chain", async () => {
    const hooks = hooksFor({});
    const result = await runFailover<Result>([], hooks);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toBe("exhausted");
    expect(hooks.runCalls).toEqual([]);
  });
});
