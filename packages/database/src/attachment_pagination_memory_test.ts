import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";

Deno.test("memory attachment pages use stable owner-scoped keyset pagination", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "files-page@example.test", name: "Files page" });
  const stranger = repo.createUser({ email: "files-page-other@example.test", name: "Other" });
  const create = (ownerId: string, ordinal: number) =>
    repo.createAttachment({
      ownerId,
      objectKey: `users/${ownerId}/page-${ordinal}`,
      filename: `page-${ordinal}.txt`,
      mimeType: "text/plain",
      sizeBytes: ordinal + 1,
      sha256: ordinal.toString(16).padStart(64, "0"),
      state: "ready",
      inspectionComplete: true,
    }).attachment;
  const first = create(owner.id, 1);
  const second = create(owner.id, 2);
  const third = create(owner.id, 3);
  const foreign = create(stranger.id, 4);
  first.createdAt = "2026-01-01T00:00:00.000Z";
  second.createdAt = "2026-01-02T00:00:00.000Z";
  third.createdAt = second.createdAt;

  const expectedAscending = [first, second, third].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
  const pageOne = repo.listAttachmentPage(owner.id, { limit: 2, order: "asc" });
  assertEquals(
    pageOne.data.map((file) => file.id),
    expectedAscending.slice(0, 2).map((file) => file.id),
  );
  assertEquals(pageOne.hasMore, true);
  const pageTwo = repo.listAttachmentPage(owner.id, {
    limit: 2,
    order: "asc",
    after: pageOne.data.at(-1)!.id,
  });
  assertEquals(
    pageTwo.data.map((file) => file.id),
    expectedAscending.slice(2).map((file) => file.id),
  );
  assertEquals(pageTwo.hasMore, false);

  const descending = repo.listAttachmentPage(owner.id, { limit: 10, order: "desc" });
  assertEquals(
    descending.data.map((file) => file.id),
    expectedAscending.toReversed().map((file) => file.id),
  );
  assertEquals(descending.data.some((file) => file.id === foreign.id), false);

  assertThrows(
    () => repo.listAttachmentPage(owner.id, { limit: 1, order: "asc", after: foreign.id }),
    DomainError,
    "invalid for this owner",
  );
  repo.deleteAttachment(second.id, owner.id);
  const expectedAfterDeleted = expectedAscending.slice(
    expectedAscending.findIndex((file) => file.id === second.id) + 1,
  ).filter((file) => file.id !== second.id);
  assertEquals(
    repo.listAttachmentPage(owner.id, { limit: 10, order: "asc", after: second.id }).data.map(
      (file) => file.id,
    ),
    expectedAfterDeleted.map((file) => file.id),
  );
  assertThrows(
    () => repo.listAttachmentPage(owner.id, { limit: 0, order: "asc" }),
    DomainError,
    "between 1 and 10000",
  );
});
