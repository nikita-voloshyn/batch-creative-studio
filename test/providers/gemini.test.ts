/**
 * Gemini adapter specifications (testing agent, Task 10).
 *
 * Mocks the `@google/genai` SDK (no live calls). Asserts request shaping for
 * `ai.models.generateContent` (model, IMAGE modality, aspect ratio, seed,
 * abortSignal, inline product+reference parts), success decoding of the inline
 * image, content-policy mapping (prompt blockReason / candidate finishReason),
 * the empty-200 anomaly (no image data → server), and SDK `ApiError` → neutral
 * `ProviderError.kind`. Inputs use `data:` URLs so image loading needs no network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderError } from "@/lib/providers/errors";
import type { GenerateInput } from "@/lib/providers/types";
import { PNG_BYTES } from "../fakes/fakeProvider";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock("@google/genai", () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  class GoogleGenAI {
    // The adapter calls `new GoogleGenAI({ apiKey })`; the arg is ignored here.
    models = { generateContent: generateContentMock };
  }
  return { GoogleGenAI, ApiError };
});

import { ApiError } from "@google/genai";
import { createGeminiProvider } from "@/lib/providers/gemini";

// The mocked ApiError (above) takes (message, status); the real SDK type's ctor
// takes a single ApiErrorInfo object, so type the mock ctor explicitly for the
// test call sites (same runtime class — only the static type differs).
const ApiErrorMock = ApiError as unknown as new (
  message: string,
  status: number,
) => Error & { status: number };

const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");
const DATA_PNG = `data:image/png;base64,${PNG_B64}`;
const SIGNAL = new AbortController().signal;

const INPUT: GenerateInput = {
  productImageUrl: DATA_PNG,
  referenceImageUrls: [DATA_PNG],
  prompt: "elegant studio shot",
  aspectRatio: "4:5",
  seed: 42,
};

/** A success response carrying one inline PNG part. */
function imageResponse() {
  return {
    candidates: [
      { content: { parts: [{ inlineData: { data: PNG_B64, mimeType: "image/png" } }] } },
    ],
  };
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = "key-abc";
  generateContentMock.mockReset();
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
});

describe("createGeminiProvider — request shaping + success decode", () => {
  test("calls generateContent with IMAGE modality, aspect ratio, seed, signal, inline parts", async () => {
    generateContentMock.mockResolvedValue(imageResponse());
    const provider = createGeminiProvider();
    expect(provider.supportsImageReference).toBe(true);

    const result = await provider.generate(INPUT, SIGNAL);

    const arg = generateContentMock.mock.calls[0][0];
    expect(arg.model).toBe("gemini-2.5-flash-image");
    expect(arg.config).toMatchObject({
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "4:5" },
      seed: 42,
    });
    expect(arg.config.abortSignal).toBe(SIGNAL);
    const parts = arg.contents[0].parts;
    expect(parts).toHaveLength(3); // text prompt + product image + 1 reference
    expect(parts[0]).toEqual({ text: "elegant studio shot" });
    expect(parts[1].inlineData.mimeType).toBe("image/png");

    expect(result.providerId).toBe("gemini");
    expect(result.usedImageReference).toBe(true);
    expect(result.imageBytes).toBeInstanceOf(Uint8Array);
    expect(result.contentType).toBe("image/png");
  });
});

describe("createGeminiProvider — content-policy mapping", () => {
  test("maps a prompt blockReason to content_policy", async () => {
    generateContentMock.mockResolvedValue({ promptFeedback: { blockReason: "SAFETY" } });
    const provider = createGeminiProvider();
    await expect(provider.generate(INPUT, SIGNAL)).rejects.toMatchObject({
      kind: "content_policy",
    });
  });

  test("maps a candidate finishReason (IMAGE_SAFETY) to content_policy", async () => {
    generateContentMock.mockResolvedValue({
      candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }],
    });
    const provider = createGeminiProvider();
    await expect(provider.generate(INPUT, SIGNAL)).rejects.toMatchObject({
      kind: "content_policy",
    });
  });
});

describe("createGeminiProvider — empty-200 anomaly (§5k)", () => {
  test("maps a 200 with no image data to a retryable server error", async () => {
    generateContentMock.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: "sorry, no image" }] } }],
    });
    const provider = createGeminiProvider();
    await expect(provider.generate(INPUT, SIGNAL)).rejects.toMatchObject({ kind: "server" });
  });
});

describe("createGeminiProvider — SDK ApiError → ProviderError.kind", () => {
  const cases: Array<[string, number, ProviderError["kind"]]> = [
    ["unauthorized", 401, "auth"],
    ["too many requests", 429, "rate_limit"],
    ["RESOURCE_EXHAUSTED: daily limit reached", 429, "quota_exhausted"],
    ["service unavailable", 503, "unavailable"],
    ["internal server error", 500, "server"],
    ["blocked for safety reasons", 400, "content_policy"],
    ["invalid argument", 400, "invalid_input"],
  ];

  for (const [message, status, kind] of cases) {
    test(`maps ApiError ${status} (${message}) to ${kind}`, async () => {
      generateContentMock.mockRejectedValue(new ApiErrorMock(message, status));
      const provider = createGeminiProvider();
      await expect(provider.generate(INPUT, SIGNAL)).rejects.toMatchObject({
        kind,
        httpStatus: status,
        providerId: "gemini",
      });
    });
  }

  test("parses a server-suggested retryDelay into retryAfterMs", async () => {
    generateContentMock.mockRejectedValue(
      new ApiErrorMock("RESOURCE_EXHAUSTED retryDelay: 12s", 429),
    );
    const provider = createGeminiProvider();
    await expect(provider.generate(INPUT, SIGNAL)).rejects.toMatchObject({
      kind: "rate_limit",
      retryAfterMs: 12_000,
    });
  });
});

describe("createGeminiProvider — guards", () => {
  test("maps an already-aborted signal to a timeout error before calling the model", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createGeminiProvider();
    await expect(provider.generate(INPUT, controller.signal)).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  test("throws auth when GEMINI_API_KEY is missing", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => createGeminiProvider()).toThrow(ProviderError);
  });
});
