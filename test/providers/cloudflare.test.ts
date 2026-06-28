/**
 * Cloudflare Workers AI adapter specifications (testing agent, Task 10).
 *
 * Mocks global `fetch` (no live calls). Asserts request SHAPING per model branch
 * (text-only JSON vs FLUX.2 multipart-with-reference-images), response DECODING
 * (base64 JSON envelope vs binary image stream), and that HTTP errors map to the
 * right neutral `ProviderError.kind` (429→rate_limit, 401→auth, 503→unavailable,
 * body-refined daily-quota→quota_exhausted, safety→content_policy). Inputs use
 * `data:` URLs so reference loading needs no network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCloudflareProvider } from "@/lib/providers/cloudflare";
import { ProviderError } from "@/lib/providers/errors";
import type { GenerateInput } from "@/lib/providers/types";
import { PNG_BYTES } from "../fakes/fakeProvider";

const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");
const DATA_PNG = `data:image/png;base64,${PNG_B64}`;
const SIGNAL = new AbortController().signal;

const INPUT: GenerateInput = {
  productImageUrl: DATA_PNG,
  referenceImageUrls: [DATA_PNG],
  prompt: "elegant studio shot",
  aspectRatio: "1:1",
  seed: 42,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
  process.env.CLOUDFLARE_API_TOKEN = "token-xyz";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_MODEL;
});

describe("createCloudflareProvider — text-only JSON branch (FLUX.1 schnell)", () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
  });

  test("reports supportsImageReference=false and sends a prompt-only JSON body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: { image: PNG_B64 }, success: true }));
    const provider = createCloudflareProvider();
    expect(provider.supportsImageReference).toBe(false);

    const result = await provider.generate(INPUT, SIGNAL);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/black-forest-labs/flux-1-schnell",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-xyz");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    // schnell: no dims, no seed in the schema.
    expect(JSON.parse(init.body as string)).toEqual({ prompt: "elegant studio shot" });

    expect(result.providerId).toBe("cloudflare");
    expect(result.usedImageReference).toBe(false);
    expect(result.imageBytes).toBeInstanceOf(Uint8Array);
    expect(result.contentType).toBe("image/png");
  });
});

describe("createCloudflareProvider — text-only JSON branch with dims+seed + binary response (SDXL)", () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";
  });

  test("sends width/height/seed and decodes a binary image stream", async () => {
    fetchMock.mockResolvedValue(
      new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
    );
    const provider = createCloudflareProvider();

    const result = await provider.generate(INPUT, SIGNAL);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      prompt: "elegant studio shot",
      width: 1024,
      height: 1024,
      seed: 42,
    });
    expect(result.imageBytes).toBeInstanceOf(Uint8Array);
    expect((result.imageBytes as Uint8Array).byteLength).toBe(PNG_BYTES.byteLength);
  });
});

describe("createCloudflareProvider — FLUX.2 multipart branch (reference images)", () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-2-klein-9b";
  });

  test("reports supportsImageReference=true and sends multipart with input images", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: { image: PNG_B64 }, success: true }));
    const provider = createCloudflareProvider();
    expect(provider.supportsImageReference).toBe(true);

    const result = await provider.generate(INPUT, SIGNAL);

    const init = fetchMock.mock.calls[0][1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-xyz");
    // multipart: fetch sets its own Content-Type/boundary -> we must NOT set it.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("prompt")).toBe("elegant studio shot");
    expect(form.has("input_image_0")).toBe(true); // product
    expect(form.has("input_image_1")).toBe(true); // reference
    expect(result.usedImageReference).toBe(true);
  });
});

describe("createCloudflareProvider — HTTP error → ProviderError.kind", () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
  });

  const cases: Array<[number, string, ProviderError["kind"]]> = [
    [429, "", "rate_limit"],
    [401, "", "auth"],
    [403, "", "auth"],
    [408, "", "timeout"],
    [503, "", "unavailable"],
    [500, "", "server"],
    [400, "", "invalid_input"],
    [429, "daily quota exceeded", "quota_exhausted"],
    [400, "blocked by safety filter", "content_policy"],
    [422, "nsfw content detected", "content_policy"],
  ];

  for (const [status, body, kind] of cases) {
    test(`maps HTTP ${status}${body ? ` (${body})` : ""} to ${kind}`, async () => {
      fetchMock.mockResolvedValue(new Response(body, { status }));
      const provider = createCloudflareProvider();
      await expect(provider.generate(INPUT, SIGNAL)).rejects.toMatchObject({
        kind,
        httpStatus: status,
        providerId: "cloudflare",
      });
    });
  }

  test("parses a Retry-After header into retryAfterMs", async () => {
    fetchMock.mockResolvedValue(
      new Response("rate limited", { status: 429, headers: { "retry-after": "12" } }),
    );
    const provider = createCloudflareProvider();
    await expect(provider.generate(INPUT, SIGNAL)).rejects.toMatchObject({
      kind: "rate_limit",
      retryAfterMs: 12_000,
    });
  });
});

describe("createCloudflareProvider — response-level failures", () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
  });

  test("maps a success:false envelope to a server error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, errors: [{ code: 7, message: "bad" }] }),
    );
    const provider = createCloudflareProvider();
    await expect(provider.generate(INPUT, SIGNAL)).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.generate(INPUT, SIGNAL)).rejects.toMatchObject({ kind: "server" });
  });

  test("maps a 200 with no image data to a server error (empty-200, §5k)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: {}, success: true }));
    const provider = createCloudflareProvider();
    await expect(provider.generate(INPUT, SIGNAL)).rejects.toMatchObject({ kind: "server" });
  });

  test("throws auth when credentials are missing", () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    expect(() => createCloudflareProvider()).toThrow(ProviderError);
  });
});
