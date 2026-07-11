export function imageMaskValidationError(file: Pick<File, "type" | "size">): string | null {
  if (file.type !== "image/png") {
    return "Masks must be PNG images with transparent areas marking the region to edit.";
  }
  if (file.size > 25 * 1024 * 1024) return "Masks must be 25 MB or smaller.";
  return null;
}

export function shouldCleanupImageMask(
  attachmentId: string | undefined,
  consumedIds: ReadonlySet<string>,
): attachmentId is string {
  return Boolean(attachmentId && !consumedIds.has(attachmentId));
}
