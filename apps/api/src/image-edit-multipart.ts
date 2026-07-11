import { Busboy } from "@fastify/busboy";
import { Readable } from "node:stream";
import { secureUploadStream, UploadSecurityError } from "./upload-security.ts";
import {
  assertImageAggregateBytes,
  decodeImage,
  IMAGE_MAX_BYTES,
  type ImageEditInput,
  type ImageEditRequest,
  imageHasAlpha,
  parseImageGenerationRequest,
} from "./images.ts";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const fields = new Set([
  "model",
  "prompt",
  "n",
  "background",
  "moderation",
  "output_compression",
  "output_format",
  "partial_images",
  "quality",
  "response_format",
  "size",
  "stream",
  "style",
  "user",
  "input_fidelity",
]);
const integers = new Set(["n", "output_compression", "partial_images"]);

function webReadable(stream: Readable) {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export async function parseImageEditMultipart(request: Request): Promise<ImageEditRequest> {
  const maximumWireBytes = 32 * 1024 * 1024 + 512 * 1024;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new UploadSecurityError(
      "invalid_multipart",
      "Content-Type must be multipart/form-data",
      400,
    );
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumWireBytes) {
    throw new UploadSecurityError(
      "image_edit_too_large",
      "Image edit upload exceeds the byte limit",
      413,
    );
  }
  if (!request.body) {
    throw new UploadSecurityError("empty_upload", "Image edit upload is empty", 400);
  }
  const values = new Map<string, string>();
  const images: Array<Promise<ImageEditInput>> = [];
  let imageFieldName: "image" | "image[]" | undefined;
  let aggregateBytes = 0;
  let aggregateExceeded = false;
  let mask: Promise<ImageEditInput> | undefined;
  let failure: unknown;
  const busboy = (() => {
    try {
      return Busboy({
        headers: { "content-type": contentType },
        limits: {
          fileSize: IMAGE_MAX_BYTES,
          files: 17,
          fields: 18,
          parts: 35,
          fieldSize: 64 * 1024,
          fieldNameSize: 100,
          headerPairs: 30,
          headerSize: 8192,
        },
      });
    } catch {
      throw new UploadSecurityError(
        "invalid_multipart",
        "Image edit multipart boundary is invalid",
        400,
      );
    }
  })();
  busboy.on("field", (name, value, nameTruncated, valueTruncated) => {
    if (nameTruncated || valueTruncated || !fields.has(name) || values.has(name)) {
      failure ??= new UploadSecurityError(
        "invalid_multipart",
        `Invalid image edit field '${name}'`,
        400,
      );
      return;
    }
    values.set(name, value);
  });
  busboy.on("file", (name, stream, filename, _encoding, mime) => {
    const sourceName = name === "image" || name === "image[]";
    if (
      (!sourceName && name !== "mask") || (name === "mask" && mask) ||
      (sourceName && images.length >= 16) ||
      (sourceName && imageFieldName !== undefined && imageFieldName !== name)
    ) {
      failure ??= new UploadSecurityError(
        "invalid_multipart",
        "Image edit file parts are invalid",
        400,
      );
      stream.resume();
      return;
    }
    if (sourceName) imageFieldName = name;
    let limited = false;
    stream.once("limit", () => limited = true);
    const parsed = (async () => {
      const budgeted = webReadable(stream as Readable).pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (aggregateExceeded) return;
            aggregateBytes += chunk.byteLength;
            if (aggregateBytes > 32 * 1024 * 1024) {
              const error = new UploadSecurityError(
                "image_edit_too_large",
                "Image edit upload exceeds the aggregate byte limit",
                413,
              );
              failure ??= error;
              aggregateExceeded = true;
              return;
            }
            controller.enqueue(chunk);
          },
        }),
      );
      const secured = secureUploadStream(budgeted, filename, mime, {
        maxBytes: IMAGE_MAX_BYTES,
        allowedTypes: IMAGE_TYPES,
      });
      const [buffer, inspection] = await Promise.all([
        new Response(secured.stream).arrayBuffer(),
        secured.inspection,
      ]);
      if (limited || stream.truncated) {
        throw new UploadSecurityError(
          "image_edit_too_large",
          "Image edit file exceeds the byte limit",
          413,
        );
      }
      const bytes = new Uint8Array(buffer);
      const image = decodeImage(bytes.toBase64());
      return {
        bytes,
        filename: inspection.filename,
        mimeType: inspection.mime as ImageEditInput["mimeType"],
        sha256: inspection.sha256,
        image,
      };
    })();
    void parsed.catch((error) => failure ??= error);
    if (name === "mask") mask = parsed;
    else images.push(parsed);
  });
  for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const) {
    busboy.on(
      event,
      () =>
        failure ??= new UploadSecurityError(
          "invalid_multipart",
          "Image edit multipart limits exceeded",
          400,
        ),
    );
  }
  const finished = new Promise<void>((resolve, reject) => {
    busboy.once("finish", resolve);
    busboy.on("error", reject);
  });
  const reader = request.body.getReader();
  let wireBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      wireBytes += next.value.byteLength;
      if (wireBytes > maximumWireBytes) {
        failure ??= new UploadSecurityError(
          "image_edit_too_large",
          "Image edit upload exceeds the byte limit",
          413,
        );
        await reader.cancel(failure).catch(() => undefined);
        break;
      }
      if (!busboy.write(next.value)) {
        await new Promise<void>((resolve) => busboy.once("drain", resolve));
      }
    }
    busboy.end();
    await finished;
  } catch {
    failure ??= new UploadSecurityError(
      "invalid_multipart",
      "Image edit multipart is malformed",
      400,
    );
  } finally {
    reader.releaseLock();
  }
  const resolvedImages = await Promise.all(images).catch((error) => {
    failure ??= error;
    return [] as ImageEditInput[];
  });
  const resolvedMask = await mask?.catch((error) => {
    failure ??= error;
    return undefined;
  });
  if (failure) throw failure;
  if (!resolvedImages.length) {
    throw new UploadSecurityError("invalid_image_edit", "At least one image is required", 422);
  }
  assertImageAggregateBytes([
    ...resolvedImages.map((part) => part.image),
    ...(resolvedMask ? [resolvedMask.image] : []),
  ]);
  const first = resolvedImages[0].image;
  if (
    resolvedImages.some((part) =>
      part.image.width !== first.width || part.image.height !== first.height
    )
  ) {
    throw new UploadSecurityError(
      "invalid_image_edit",
      "All source images must have matching dimensions",
      422,
    );
  }
  if (new Set(resolvedImages.map((part) => part.sha256)).size !== resolvedImages.length) {
    throw new UploadSecurityError(
      "duplicate_image",
      "Each source image must be distinct",
      422,
    );
  }
  if (resolvedMask && resolvedImages.some((part) => part.sha256 === resolvedMask.sha256)) {
    throw new UploadSecurityError(
      "duplicate_image",
      "The mask must be distinct from every source image",
      422,
    );
  }
  if (
    resolvedMask && (
      resolvedMask.image.format !== "png" || resolvedMask.image.width !== first.width ||
      resolvedMask.image.height !== first.height || !imageHasAlpha(resolvedMask.image)
    )
  ) {
    throw new UploadSecurityError(
      "invalid_mask",
      "Mask must match the source format and dimensions and contain alpha",
      422,
    );
  }
  const body: Record<string, unknown> = {};
  let inputFidelity: "high" | "low" | undefined;
  for (const [name, value] of values) {
    if (name === "input_fidelity") {
      if (value !== "high" && value !== "low") {
        throw new UploadSecurityError("invalid_image_edit", "input_fidelity is invalid", 422);
      }
      inputFidelity = value;
      continue;
    }
    body[name] = integers.has(name)
      ? Number(value)
      : name === "stream"
      ? value === "true" ? true : value === "false" ? false : value
      : value;
  }
  if (body.model === undefined) {
    throw new UploadSecurityError(
      "model_required",
      "model is required because this installation has no global image-edit default",
      422,
    );
  }
  const normalized = parseImageGenerationRequest(body);
  return {
    ...normalized,
    images: resolvedImages,
    ...(resolvedMask ? { mask: resolvedMask } : {}),
    ...(inputFidelity ? { inputFidelity } : {}),
  };
}
