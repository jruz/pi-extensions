import { describe, expect, it } from "vitest";
import { statePreviewSchema, stateStyles } from "./states.ts";

describe("neutral CI state previews", () => {
  it("uses an accent dot for running", () => {
    expect(stateStyles.running).toEqual({
      color: "accent",
      title: "● Woodpecker CI · Running",
    });
  });

  it("uses a muted empty circle for pending", () => {
    expect(stateStyles.pending).toEqual({
      color: "muted",
      title: "○ Woodpecker CI · Pending",
    });
  });

  it("rejects states that require another renderer", () => {
    const parsed = statePreviewSchema.safeParse("failure");
    expect(parsed.success).toBe(false);
  });
});
