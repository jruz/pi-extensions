import { describe, expect, it } from "vitest";
import { statePreviewSchema, stateStyles } from "./states.ts";

describe("neutral CI state previews", () => {
  it("uses an accent dot for running", () => {
    expect(stateStyles.running).toEqual({
      title: "● Woodpecker CI · Running",
      color: "accent",
    });
  });

  it("uses a muted empty circle for pending", () => {
    expect(stateStyles.pending).toEqual({
      title: "○ Woodpecker CI · Pending",
      color: "muted",
    });
  });

  it("rejects states that require another renderer", () => {
    const parsed = statePreviewSchema.safeParse("failure");
    expect(parsed.success).toBe(false);
  });
});
