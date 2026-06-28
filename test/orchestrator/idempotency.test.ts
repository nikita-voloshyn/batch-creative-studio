/**
 * Provider-call idempotency specifications (testing agent, Task 10).
 *
 * `idempotencyKey(itemId, attemptNumber)` is a stable per-(item,attempt) hash;
 * `dedupe` coalesces CONCURRENT identical calls onto one in-flight promise and
 * clears on settle so a later sequential call (a deliberate retry) runs again
 * (product-flow §0 idempotency invariant; decisions.md 2026-06-26).
 */
import { describe, expect, test, vi } from "vitest";
import { dedupe, idempotencyKey } from "@/lib/orchestrator/idempotency";

describe("idempotencyKey", () => {
  test("is deterministic for the same (item, attempt)", () => {
    expect(idempotencyKey("item-1", 0)).toBe(idempotencyKey("item-1", 0));
  });

  test("differs across attempt numbers (a retry is a distinct key)", () => {
    expect(idempotencyKey("item-1", 0)).not.toBe(idempotencyKey("item-1", 1));
  });

  test("differs across items", () => {
    expect(idempotencyKey("item-1", 0)).not.toBe(idempotencyKey("item-2", 0));
  });
});

describe("dedupe", () => {
  test("coalesces concurrent identical calls onto one execution", async () => {
    const fn = vi.fn(async () => "result");
    const [a, b] = await Promise.all([dedupe("k1", fn), dedupe("k1", fn)]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toBe("result");
    expect(b).toBe("result");
  });

  test("runs again on a later sequential call (entry cleared on settle)", async () => {
    const fn = vi.fn(async () => "ok");
    await dedupe("k2", fn);
    await dedupe("k2", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("does not coalesce distinct keys", async () => {
    const fn = vi.fn(async (v: string) => v);
    await Promise.all([dedupe("a", () => fn("a")), dedupe("b", () => fn("b"))]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("propagates rejection and clears so a retry can re-run", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(dedupe("k3", failing)).rejects.toThrow("boom");
    const ok = vi.fn(async () => "recovered");
    await expect(dedupe("k3", ok)).resolves.toBe("recovered");
  });
});
