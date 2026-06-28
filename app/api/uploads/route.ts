/**
 * Signed, direct-to-Blob upload endpoint (component C7, backend).
 *
 * This is the server side of Vercel Blob **client uploads**. It is the ONLY
 * place the Blob write token (`BLOB_READ_WRITE_TOKEN`) is read; that secret is
 * never sent to the browser. The browser uploads bytes **directly** to Blob
 * using a short-lived client token minted here; image bytes never pass through
 * this function (architecture §1, §8.1, §9; product-flow §2.4 / §7).
 *
 * ── Real `@vercel/blob` client-upload mechanism (Context7-verified, v2.5.0) ──
 * The supported flow is a TWO-PHASE token exchange via `handleUpload()`, NOT a
 * single presigned `PUT` URL. The architecture §7.2 doc idealized the contract
 * as `POST /api/uploads { filename, contentType, kind } -> { uploadUrl, blobUrl }`;
 * the real API diverges, so the FRONTEND (Task 2 `lib/client/uploadClient.ts`)
 * must drive uploads with `@vercel/blob/client`'s `upload()` helper. See the
 * "FRONTEND CONTRACT" block below for the exact required client shape.
 *
 *   1. `upload(pathname, file, { access: "public", handleUploadUrl: "/api/uploads",
 *      contentType, clientPayload })` (client) POSTs a
 *      `{ type: "blob.generate-client-token", payload: { pathname, clientPayload, … } }`
 *      body to THIS route.
 *   2. `handleUpload()` (here) runs `onBeforeGenerateToken`, where we enforce the
 *      allowed content-types + max size (baked authoritatively into the token, so
 *      Blob rejects any oversize / wrong-type upload) and validate `kind`. It
 *      returns `{ type: "blob.generate-client-token", clientToken }`.
 *   3. The client `upload()` PUTs the bytes straight to Blob with that token and
 *      resolves to a `PutBlobResult` whose `.url` is the durable blob URL.
 *   4. The client `upload()` resolves with the durable `.url` directly, so we do
 *      NOT register an `onUploadCompleted` callback (the MVP has no DB to update).
 *      Registering one would force @vercel/blob to embed a callback URL in the
 *      token, which it cannot determine on localhost — breaking dev uploads.
 *
 * ── Server-side validation enforced here (architecture §7.2 / §9) ──
 *   • Content-type ∈ { image/png, image/jpeg, image/webp } — via `allowedContentTypes`.
 *   • Size ≤ 10 MB — via `maximumSizeInBytes` (the authoritative server-side size
 *     guard; the request carries no client-declared size).
 *   • `kind` ∈ { product, reference } — parsed from `clientPayload` and required.
 *   • `pathname` namespace — must be `uploads/{kind}/…` (path-injection guard +
 *     realizes the architecture §8.1 `uploads/{kind}/{uuid}.{ext}` layout;
 *     `addRandomSuffix` provides the unique `{uuid}` component).
 *
 * ── FRONTEND CONTRACT (cross-task note for Task 2 `lib/client/uploadClient.ts`) ──
 * The current `uploadClient.ts` expects `{ uploadUrl, blobUrl }` and does a manual
 * `PUT`. That shape does NOT exist with `@vercel/blob` today. The client must
 * instead call (browser-side):
 *
 *     import { upload } from "@vercel/blob/client";
 *     const result = await upload(`uploads/${kind}/${file.name}`, file, {
 *       access: "public",
 *       handleUploadUrl: "/api/uploads",
 *       contentType: file.type,            // image/png | image/jpeg | image/webp
 *       clientPayload: JSON.stringify({ kind }), // "product" | "reference"
 *     });
 *     return result.url;                   // durable blobUrl
 *
 * Requirements the client MUST satisfy for this route to accept the token:
 *   • `pathname` MUST start with `uploads/${kind}/` (else 400).
 *   • `clientPayload` MUST be `JSON.stringify({ kind })` with a valid `kind` (else 400).
 *   • `contentType` MUST be one of the allowed image types (else Blob rejects the PUT).
 */
import { type HandleUploadBody, handleUpload } from "@vercel/blob/client";
import { NextResponse } from "next/server";

/** Allowed upload content types (architecture §7.2 / §9; product-flow §0). */
const ALLOWED_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** Max upload size: 10 MB (architecture §9; product-flow §2.2 / §5h). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Upload buckets — product image vs. style/mood reference (architecture §7.2). */
const ALLOWED_KINDS = ["product", "reference"] as const;
type UploadKind = (typeof ALLOWED_KINDS)[number];

// Node.js runtime + always-dynamic: this route mints a per-request client token
// from a server-only secret and must never be statically cached (architecture §11).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isUploadKind(value: unknown): value is UploadKind {
  return typeof value === "string" && (ALLOWED_KINDS as readonly string[]).includes(value);
}

/** Extract and validate `kind` from the client payload; throws on anything invalid. */
function parseKind(clientPayload: string | null): UploadKind {
  if (!clientPayload) {
    throw new Error('Missing clientPayload: expected JSON { kind: "product" | "reference" }.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientPayload);
  } catch {
    throw new Error("Invalid clientPayload: not valid JSON.");
  }
  const kind = (parsed as { kind?: unknown })?.kind;
  if (!isUploadKind(kind)) {
    throw new Error(`Invalid "kind": expected one of ${ALLOWED_KINDS.join(", ")}.`);
  }
  return kind;
}

export async function POST(request: Request): Promise<NextResponse> {
  // The Blob write token is the only secret used here and stays server-side.
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Upload service is not configured (missing BLOB_READ_WRITE_TOKEN)." },
      { status: 500 },
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body: expected JSON." }, { status: 400 });
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const kind = parseKind(clientPayload);
        const expectedPrefix = `uploads/${kind}/`;
        if (!pathname.startsWith(expectedPrefix)) {
          throw new Error(`Invalid pathname: must start with "${expectedPrefix}".`);
        }
        return {
          allowedContentTypes: [...ALLOWED_CONTENT_TYPES],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
          // Bucket tag carried in the token; cheap audit trail.
          tokenPayload: JSON.stringify({ kind }),
        };
      },
      // NB: no `onUploadCompleted`. The MVP keeps state in-memory and the durable
      // blobUrl is returned to the client by upload() directly, so we don't need
      // the post-upload callback. Providing it would force @vercel/blob to embed a
      // callback URL in the minted token, which it cannot determine on localhost
      // ("no callbackUrl could be determined") — breaking client uploads in dev.
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    // Validation failures from onBeforeGenerateToken (bad kind / pathname /
    // payload) and token-mint errors land here. The client surfaces this as a
    // failed sign step (uploadClient `UploadError`).
    const message = error instanceof Error ? error.message : "Upload could not be authorized.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
