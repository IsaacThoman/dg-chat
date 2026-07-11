import type {
  GeneratedAsset,
  GeneratedAssetFilters,
  GeneratedAssetPage,
  ImageEditInput,
  ImageGenerationInput,
  ImageGenerationResult,
} from "./types.ts";

export class ImageApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ImageApiError";
  }
}

export type ImageRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export const imageRequest: ImageRequest = async <T>(path: string, init?: RequestInit) => {
  const response = await fetch(path, { credentials: "include", ...init });
  if (!response.ok) {
    let code = "request_failed";
    let message = `Image request failed (${response.status})`;
    try {
      const value = await response.json() as { error?: { code?: string; message?: string } };
      if (value.error?.code) code = value.error.code.slice(0, 100);
      if (value.error?.message) message = value.error.message.slice(0, 500);
    } catch { /* Never reflect an untrusted HTML error body. */ }
    throw new ImageApiError(response.status, code, message);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
};

function jsonBody(value: unknown, idempotencyKey?: string, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(value),
    signal,
  };
}

function generationBody(input: ImageGenerationInput | ImageEditInput) {
  const { count, ...rest } = input;
  return { ...rest, ...(count === undefined ? {} : { n: count }) };
}

function editBody(input: ImageEditInput) {
  const { count, sourceAssetId: _sourceAssetId, sourceAttachmentId, maskAttachmentId, ...rest } =
    input;
  return {
    ...rest,
    images: [{ file_id: sourceAttachmentId }],
    ...(maskAttachmentId ? { mask: { file_id: maskAttachmentId } } : {}),
    ...(count === undefined ? {} : { n: count }),
  };
}

export function createImageApi(request: ImageRequest = imageRequest) {
  return {
    generate: (input: ImageGenerationInput, idempotencyKey: string, signal?: AbortSignal) =>
      request<ImageGenerationResult>(
        "/api/images/generations",
        jsonBody(generationBody(input), idempotencyKey, signal),
      ),
    edit: (input: ImageEditInput, idempotencyKey: string, signal?: AbortSignal) =>
      request<ImageGenerationResult>(
        "/api/images/edits",
        jsonBody(editBody(input), idempotencyKey, signal),
      ),
    list: (filters: GeneratedAssetFilters = {}, signal?: AbortSignal) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== "") {
          query.set(key === "includeDeleted" ? "include_deleted" : key, String(value));
        }
      }
      const suffix = query.size ? `?${query}` : "";
      return request<GeneratedAssetPage>(`/api/images${suffix}`, { signal });
    },
    retrieve: (id: string) => request<GeneratedAsset>(`/api/images/${encodeURIComponent(id)}`),
    retrieveSource: (attachmentId: string, before: string, exclude: string) =>
      request<GeneratedAsset>(
        `/api/images/by-attachment/${encodeURIComponent(attachmentId)}?before=${
          encodeURIComponent(before)
        }&exclude=${encodeURIComponent(exclude)}`,
      ),
    remove: (id: string) =>
      request<void>(`/api/images/${encodeURIComponent(id)}`, { method: "DELETE" }),
    restore: (id: string) =>
      request<GeneratedAsset>(`/api/images/${encodeURIComponent(id)}/restore`, {
        method: "POST",
      }),
  };
}

export const imageApi = createImageApi();
