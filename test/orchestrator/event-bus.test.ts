/**
 * Per-job event-bus specifications (testing agent, Task 10).
 *
 * The bus is the in-process SSE replay buffer behind reconnect (product-flow §5f):
 * monotonic ids for `Last-Event-ID`, a bounded ring buffer, backlog-then-live
 * subscription, and subscriber isolation (a closed SSE writer must never break the
 * emit loop). Part of the reliability core.
 */
import { describe, expect, test } from "vitest";
import {
  deleteJobEventBus,
  getJobEventBus,
  JobEventBus,
  peekJobEventBus,
} from "@/lib/orchestrator/event-bus";

describe("JobEventBus", () => {
  test("assigns monotonic ids and advances lastEventId", () => {
    const bus = new JobEventBus("j");
    expect(bus.lastEventId).toBe(0);
    const a = bus.emit("item.status", { itemId: "i1", status: "running" });
    const b = bus.emit("job.progress", { done: 1, failed: 0, total: 2 });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(bus.lastEventId).toBe(2);
  });

  test("replaySince returns only events strictly after the cursor", () => {
    const bus = new JobEventBus("j");
    bus.emit("item.status", { itemId: "i1", status: "running" });
    bus.emit("item.status", { itemId: "i2", status: "running" });
    bus.emit("job.done", { status: "completed" });

    expect(bus.replaySince(0)).toHaveLength(3); // full backlog
    const tail = bus.replaySince(2);
    expect(tail).toHaveLength(1);
    expect(tail[0].name).toBe("job.done");
  });

  test("subscribe replays the backlog after sinceId then forwards live events", () => {
    const bus = new JobEventBus("j");
    bus.emit("item.status", { itemId: "i1", status: "running" });
    bus.emit("item.result", {
      itemId: "i1",
      imageUrl: "u",
      providerId: "gemini",
      usedImageReference: true,
    });

    const seen: string[] = [];
    const unsubscribe = bus.subscribe((e) => seen.push(e.name), 1);
    expect(seen).toEqual(["item.result"]); // backlog after id 1

    bus.emit("job.done", { status: "completed" });
    expect(seen).toEqual(["item.result", "job.done"]); // live forwarded
    unsubscribe();
    bus.emit("job.progress", { done: 1, failed: 0, total: 1 });
    expect(seen).toEqual(["item.result", "job.done"]); // no longer subscribed
  });

  test("a throwing subscriber never breaks the emit loop for others", () => {
    const bus = new JobEventBus("j");
    const good: string[] = [];
    bus.subscribe(() => {
      throw new Error("closed writer");
    });
    bus.subscribe((e) => good.push(e.name));
    expect(() => bus.emit("job.done", { status: "completed" })).not.toThrow();
    expect(good).toEqual(["job.done"]);
  });

  test("trims the ring buffer to its limit", () => {
    const bus = new JobEventBus("j", 2);
    bus.emit("item.status", { itemId: "i1", status: "running" });
    bus.emit("item.status", { itemId: "i2", status: "running" });
    bus.emit("item.status", { itemId: "i3", status: "running" });
    const all = bus.replaySince(0);
    expect(all).toHaveLength(2); // oldest trimmed
    expect(all.map((e) => e.id)).toEqual([2, 3]);
  });

  test("close drops subscribers but retains the buffer for late replay", () => {
    const bus = new JobEventBus("j");
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.name));
    bus.emit("item.status", { itemId: "i1", status: "running" });
    bus.close();
    bus.emit("job.done", { status: "completed" });
    expect(seen).toEqual(["item.status"]); // no live delivery after close
    expect(bus.replaySince(0)).toHaveLength(2); // buffer retained
  });
});

describe("event-bus registry", () => {
  test("getJobEventBus returns a stable instance; peek and delete manage lifecycle", () => {
    const a = getJobEventBus("job-x");
    const b = getJobEventBus("job-x");
    expect(a).toBe(b);
    expect(peekJobEventBus("job-x")).toBe(a);

    deleteJobEventBus("job-x");
    expect(peekJobEventBus("job-x")).toBeUndefined();
  });
});
