import { describe, expect, it } from "vitest";
import {
  conversationIdsForWorkspace,
  type FolderData,
  type TagData,
} from "./WorkspaceNavigation.tsx";
import type { Conversation } from "../types.ts";

const conversations: Conversation[] = ["a", "b", "c"].map((id) => ({
  id,
  title: id,
  preview: "",
  updatedAt: "now",
}));
const folders = {
  data: [],
  memberships: [
    {
      folderId: "folder",
      conversationId: "a",
      ownerId: "owner",
      position: 0,
      createdAt: "",
      updatedAt: "",
    },
    {
      folderId: "folder",
      conversationId: "b",
      ownerId: "owner",
      position: 1,
      createdAt: "",
      updatedAt: "",
    },
  ],
} as FolderData;
const tags = {
  data: [],
  tagSets: [],
  bindings: [
    { conversationId: "a", tagId: "red", ownerId: "owner", createdAt: "" },
    { conversationId: "a", tagId: "blue", ownerId: "owner", createdAt: "" },
    { conversationId: "b", tagId: "red", ownerId: "owner", createdAt: "" },
  ],
} as TagData;

describe("conversationIdsForWorkspace", () => {
  it("intersects a project with every selected tag", () => {
    expect(conversationIdsForWorkspace(conversations, folders, tags, "folder", ["red", "blue"]))
      .toEqual(["a"]);
  });

  it("returns every conversation when no workspace filter is active", () => {
    expect(conversationIdsForWorkspace(conversations, folders, tags, null, [])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
