export interface AttachmentInspectionPayload {
  attachmentId: string;
  ownerId: string;
}

export class AttachmentInspectionPendingError extends Error {
  override name = "AttachmentInspectionPendingError";
}

export function parseAttachmentInspectionPayload(payload: unknown): AttachmentInspectionPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("attachment.inspect payload must be an object");
  }
  const { attachmentId, ownerId } = payload as Record<string, unknown>;
  if (typeof attachmentId !== "string" || typeof ownerId !== "string") {
    throw new Error("attachment.inspect payload is missing attachmentId or ownerId");
  }
  return { attachmentId, ownerId };
}

export function assertAttachmentInspectionTerminal(state: string | undefined): void {
  if (!state) throw new Error("Attachment for inspection job was not found");
  if (state === "pending" || state === "inspecting") {
    throw new AttachmentInspectionPendingError(
      `Attachment is still ${state}; upload validation must finish before the inspection job can complete`,
    );
  }
  if (!["ready", "quarantined", "failed", "deleted"].includes(state)) {
    throw new Error(`Attachment has unknown state: ${state}`);
  }
}
