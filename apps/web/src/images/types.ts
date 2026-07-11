export type ImageOperation = "generation" | "edit";
export type GeneratedAssetStatus = "processing" | "ready" | "failed" | "deleted";

export interface GeneratedAsset {
  id: string;
  attachmentId: string | null;
  contentUrl: string | null;
  thumbnailUrl?: string | null;
  sourceAttachmentIds: string[];
  operation: ImageOperation;
  prompt: string;
  revisedPrompt?: string | null;
  model: string;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  sizeBytes: number | null;
  status: GeneratedAssetStatus;
  costMicros?: number | null;
  createdAt: string;
  deletedAt?: string | null;
}

export interface ImageGenerationInput {
  prompt: string;
  model: string;
  size?: string;
  quality?: string;
  count?: number;
}

export interface ImageEditInput extends ImageGenerationInput {
  sourceAssetId: string;
}

export interface GeneratedAssetPage {
  data: GeneratedAsset[];
  nextCursor: string | null;
}

export interface GeneratedAssetFilters {
  cursor?: string;
  limit?: number;
  operation?: ImageOperation;
  query?: string;
  model?: string;
  deleted?: boolean;
  includeDeleted?: boolean;
}

export interface ImageGenerationResult {
  assets: GeneratedAsset[];
  costMicros?: number | null;
}
