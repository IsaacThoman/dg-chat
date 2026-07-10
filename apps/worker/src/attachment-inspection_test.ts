import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  assertAttachmentInspectionTerminal,
  AttachmentInspectionPendingError,
  parseAttachmentInspectionPayload,
} from "./attachment-inspection.ts";

Deno.test("attachment inspection payload requires both ownership identifiers", () => {
  assertEquals(parseAttachmentInspectionPayload({ attachmentId: "file", ownerId: "owner" }), {
    attachmentId: "file",
    ownerId: "owner",
  });
  assertThrows(() => parseAttachmentInspectionPayload(null));
  assertThrows(() => parseAttachmentInspectionPayload({ attachmentId: "file" }));
});

Deno.test("attachment inspection completes only for terminal states", () => {
  for (const state of ["ready", "quarantined", "failed", "deleted"]) {
    assertEquals(assertAttachmentInspectionTerminal(state), undefined);
  }
  for (const state of [undefined, "invented"]) {
    assertThrows(() => assertAttachmentInspectionTerminal(state));
  }
  for (const state of ["pending", "inspecting"]) {
    assertThrows(
      () => assertAttachmentInspectionTerminal(state),
      AttachmentInspectionPendingError,
    );
  }
});
