/**
 * Result-store specifications (testing agent, Task 10).
 *
 * Asserts the per-item, attempt-independent Blob key
 * `results/{jobId}/{itemId}.{ext}` with last-writer-wins semantics
 * (`addRandomSuffix:false` + `allowOverwrite:true`) and that the adapter-declared
 * `contentType` is PREFERRED over magic-byte sniffing for `{ext}` — so a
 * format-changing failover (e.g. PNG→WEBP) resolves a deterministic, stable key
 * with no orphan blob (decisions.md 2026-06-26, architecture §5.5). `@vercel/blob`
 * `put` is mocked; no live Blob calls.
 */

import { put } from "@vercel/blob";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { persistResult } from "@/lib/blob/result-store";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "../fakes/fakeProvider";

vi.mock("@vercel/blob", () => ({ put: vi.fn() }));

const mockedPut = vi.mocked(put);

beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  mockedPut.mockReset();
  mockedPut.mockImplementation(
    async (key: string) => ({ url: `https://blob.example/${key}` }) as never,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Last (key, body, options) the mocked `put` was called with. */
function lastPut() {
  const calls = mockedPut.mock.calls;
  const [key, body, options] = calls[calls.length - 1];
  return { key, body, options: options as unknown as Record<string, unknown> };
}

describe("persistResult — per-item key + last-writer-wins", () => {
  test("writes to results/{jobId}/{itemId}.{ext} with overwrite semantics", async () => {
    const out = await persistResult({
      jobId: "job1",
      itemId: "item1",
      imageBytes: PNG_BYTES,
      contentType: "image/png",
    });

    const { key, options } = lastPut();
    expect(key).toBe("results/job1/item1.png");
    expect(options).toMatchObject({
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false, // stable key …
      allowOverwrite: true, // … last-writer-wins (no orphan)
      token: "test-token",
    });
    expect(out.imageUrl).toBe("https://blob.example/results/job1/item1.png");
    expect(out.contentType).toBe("image/png");
  });

  test("two successive writes for the same item reuse the identical key (no orphan)", async () => {
    await persistResult({
      jobId: "j",
      itemId: "i",
      imageBytes: PNG_BYTES,
      contentType: "image/png",
    });
    await persistResult({
      jobId: "j",
      itemId: "i",
      imageBytes: PNG_BYTES,
      contentType: "image/png",
    });

    expect(mockedPut.mock.calls[0][0]).toBe("results/j/i.png");
    expect(mockedPut.mock.calls[1][0]).toBe("results/j/i.png");
  });
});

describe("persistResult — content-type resolution for {ext}", () => {
  test("PREFERS the declared contentType over magic-byte sniffing (PNG bytes, webp declared)", async () => {
    const out = await persistResult({
      jobId: "j",
      itemId: "i",
      imageBytes: PNG_BYTES, // sniffs as png …
      contentType: "image/webp", // … but the adapter declares webp
    });
    const { key, options } = lastPut();
    expect(key).toBe("results/j/i.webp");
    expect(options.contentType).toBe("image/webp");
    expect(out.contentType).toBe("image/webp");
  });

  test("falls back to magic-byte sniffing when no contentType is declared", async () => {
    await persistResult({ jobId: "j", itemId: "a", imageBytes: PNG_BYTES });
    expect(lastPut().key).toBe("results/j/a.png");

    await persistResult({ jobId: "j", itemId: "b", imageBytes: JPEG_BYTES });
    expect(lastPut().key).toBe("results/j/b.jpg");

    await persistResult({ jobId: "j", itemId: "c", imageBytes: WEBP_BYTES });
    expect(lastPut().key).toBe("results/j/c.webp");
  });

  test("ignores a disallowed declared contentType and sniffs instead", async () => {
    await persistResult({
      jobId: "j",
      itemId: "i",
      imageBytes: PNG_BYTES,
      contentType: "image/gif", // not allowed -> sniff
    });
    expect(lastPut().key).toBe("results/j/i.png");
    expect(lastPut().options.contentType).toBe("image/png");
  });
});

describe("persistResult — provider-URL (re-persist) path", () => {
  test("fetches an https provider URL and keeps the response content-type ext", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(WEBP_BYTES, { status: 200, headers: { "content-type": "image/webp" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await persistResult({
      jobId: "j",
      itemId: "url1",
      imageBytes: "https://blob.example/remote-image",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastPut().key).toBe("results/j/url1.webp");
    expect(out.contentType).toBe("image/webp");
  });
});

describe("persistResult — guards", () => {
  test("throws when the Blob write token is missing", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "";
    await expect(persistResult({ jobId: "j", itemId: "i", imageBytes: PNG_BYTES })).rejects.toThrow(
      /BLOB_READ_WRITE_TOKEN/,
    );
  });

  test("throws on zero-byte result bytes", async () => {
    await expect(
      persistResult({ jobId: "j", itemId: "i", imageBytes: new Uint8Array(0) }),
    ).rejects.toThrow(/zero bytes/);
  });
});
