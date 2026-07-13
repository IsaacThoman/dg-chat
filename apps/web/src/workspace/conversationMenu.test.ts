import { describe, expect, it } from "vitest";
import { conversationMenuPosition } from "./conversationMenu.ts";

describe("conversationMenuPosition", () => {
  it("places a menu below its trigger when space is available", () => {
    expect(conversationMenuPosition(
      { left: 200, right: 240, top: 40, bottom: 80 },
      { width: 1200, height: 800 },
      { width: 180, height: 200 },
    )).toEqual({ left: 60, top: 84 });
  });

  it("flips above and clamps within narrow mobile viewports", () => {
    const position = conversationMenuPosition(
      { left: 280, right: 320, top: 500, bottom: 544 },
      { width: 320, height: 560 },
      { width: 180, height: 210 },
    );
    expect(position).toEqual({ left: 132, top: 286 });
  });
});
