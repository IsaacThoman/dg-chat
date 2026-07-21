import { describe, expect, it } from "vitest";
import {
  chatComposerRequiresRetention,
  chatSessionProtectionStatus,
  chatSessionQueryActivity,
  MAX_RETAINED_CHAT_SESSIONS,
  planChatSessionVisit,
  protectedChatReviewTarget,
  pruneChatSessions,
  rememberChatSession,
  retainVisitedChatSession,
} from "./chatSessionRetention.ts";

describe("chat session retention", () => {
  it("keeps unique sessions in least-recently-used order", () => {
    const sessions = rememberChatSession(["a", "b", "c"], "a");
    expect(sessions).toEqual(["b", "c", "a"]);
    expect(rememberChatSession(sessions, "a")).toBe(sessions);
    expect(rememberChatSession(sessions, "")).toEqual(sessions);
  });

  it("evicts the oldest clean inactive session above the soft bound", () => {
    const sessions = Array.from(
      { length: MAX_RETAINED_CHAT_SESSIONS },
      (_, index) => `conversation-${index + 1}`,
    );
    expect(retainVisitedChatSession(sessions, "conversation-7", new Set())).toEqual([
      "conversation-2",
      "conversation-3",
      "conversation-4",
      "conversation-5",
      "conversation-6",
      "conversation-7",
    ]);
  });

  it("never evicts active or protected sessions", () => {
    const sessions = ["draft", "streaming", "clean", "d", "e", "f", "active"];
    expect(pruneChatSessions(sessions, {
      activeId: "active",
      protectedIds: new Set(["draft", "streaming"]),
      limit: 4,
    })).toEqual(["draft", "streaming", "f", "active"]);
  });

  it("refuses a new mount when every bounded session contains protected work", () => {
    const sessions = ["draft-a", "draft-b", "stream", "upload"];
    const result = planChatSessionVisit(sessions, "new", new Set(sessions), 4);
    expect(result).toEqual({ admitted: false, sessionIds: sessions });
    expect(result.sessionIds).toHaveLength(4);
  });

  it("revisits protected sessions and admits new work after one session becomes clean", () => {
    const sessions = ["draft-a", "draft-b", "stream", "upload"];
    expect(planChatSessionVisit(sessions, "draft-a", new Set(sessions), 4)).toEqual({
      admitted: true,
      sessionIds: ["draft-b", "stream", "upload", "draft-a"],
    });
    expect(
      planChatSessionVisit(sessions, "new", new Set(["draft-a", "stream", "upload"]), 4),
    ).toEqual({
      admitted: true,
      sessionIds: ["draft-a", "stream", "upload", "new"],
    });
  });

  it("repairs a legacy over-cap visit without evicting any protected session", () => {
    const sessions = [
      "clean-oldest",
      "draft-a",
      "clean-middle",
      "stream",
      "upload",
      "clean-newest",
      "draft-b",
      "clean-last",
    ];
    const protectedIds = new Set(["draft-a", "stream", "upload", "draft-b"]);

    expect(planChatSessionVisit(sessions, "new", protectedIds, 6)).toEqual({
      admitted: true,
      sessionIds: ["draft-a", "stream", "upload", "draft-b", "clean-last", "new"],
    });
  });

  it("repairs all removable over-cap entries and rejects a visit when protected work exceeds the cap", () => {
    const sessions = [
      "draft-a",
      "clean-a",
      "stream-a",
      "draft-b",
      "upload-a",
      "clean-b",
      "stream-b",
      "draft-c",
      "upload-b",
    ];
    const protectedIds = new Set([
      "draft-a",
      "stream-a",
      "draft-b",
      "upload-a",
      "stream-b",
      "draft-c",
      "upload-b",
    ]);

    expect(planChatSessionVisit(sessions, "new", protectedIds, 6)).toEqual({
      admitted: false,
      sessionIds: [
        "draft-a",
        "stream-a",
        "draft-b",
        "upload-a",
        "stream-b",
        "draft-c",
        "upload-b",
      ],
    });
  });

  it("deduplicates a legacy over-cap list while preserving protected LRU order", () => {
    const sessions = ["draft", "clean-a", "draft", "stream", "clean-b", "clean-c"];
    expect(planChatSessionVisit(sessions, "new", new Set(["draft", "stream"]), 4)).toEqual({
      admitted: true,
      sessionIds: ["draft", "stream", "clean-c", "new"],
    });
  });

  it("keeps inactive retained message observers dormant", () => {
    expect(chatSessionQueryActivity(false)).toEqual({
      enabled: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    expect(chatSessionQueryActivity(true)).toEqual({
      enabled: true,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    });
  });

  it("describes response work before other unfinished retained work", () => {
    const responses = new Set(["streaming"]);
    const unfinished = new Set(["streaming", "draft"]);
    expect(chatSessionProtectionStatus("streaming", responses, unfinished)).toBe("response");
    expect(chatSessionProtectionStatus("draft", responses, unfinished)).toBe("unfinished");
    expect(chatSessionProtectionStatus("clean", responses, unfinished)).toBeNull();
  });

  it("reviews the oldest protected chat other than the active chat", () => {
    const sessions = ["oldest-draft", "clean", "active-draft"];
    const protectedIds = new Set(["oldest-draft", "active-draft"]);
    expect(protectedChatReviewTarget(sessions, protectedIds, "active-draft"))
      .toBe("oldest-draft");
    expect(protectedChatReviewTarget(["active-draft"], protectedIds, "active-draft"))
      .toBe("active-draft");
    expect(protectedChatReviewTarget(sessions, new Set(), "active-draft")).toBeNull();
  });

  it.each([
    ["draft", { hasDraft: true }],
    ["immutable edit", { editing: true }],
    ["upload", { uploadCount: 1 }],
    ["approved tool result", { approvedToolCount: 1 }],
    ["selected generated asset", { selectedAssetCount: 1 }],
    ["recording or transcription", { recordingOrTranscribing: true }],
    ["image generation", { imageGenerationBusy: true }],
    ["image mutation", { imageMutationCount: 1 }],
    ["image panel", { imagePanelOpen: true }],
    ["tool approval", { toolApprovalOpen: true }],
  ])("protects a composer containing %s state", (_, patch) => {
    expect(chatComposerRequiresRetention({
      hasDraft: false,
      editing: false,
      uploadCount: 0,
      approvedToolCount: 0,
      selectedAssetCount: 0,
      recordingOrTranscribing: false,
      imageGenerationBusy: false,
      imageMutationCount: 0,
      imagePanelOpen: false,
      toolApprovalOpen: false,
      ...patch,
    })).toBe(true);
  });
});
