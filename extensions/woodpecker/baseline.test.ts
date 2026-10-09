import { describe, expect, it } from "vitest";
import { formatWatchBaseline } from "./baseline.ts";

describe("watch baseline", () => {
  it("explains an empty branch filter instead of printing an empty header", () => {
    const text = formatWatchBaseline(
      "jruz/claude-statusline",
      { kind: "branch", value: "v0.4.3" },
      [],
    );
    expect(text).toContain("Watching Woodpecker CI");
    expect(text).toContain("branch v0.4.3");
    expect(text).toContain("No pipelines match this exact branch filter");
    expect(text).toContain("Tags are not matched as branches");
    expect(text).not.toContain("Current pipelines:");
    expect(text).toContain("Awaiting a matching pipeline, not success");
  });

  it("includes observed pipelines when the branch has a baseline", () => {
    const pipeline = {
      id: 20,
      number: 20,
      status: "success",
      branch: "main",
      commit: "abc123",
    };
    const text = formatWatchBaseline(
      "jruz/claude-statusline",
      { kind: "branch", value: "main" },
      [pipeline],
    );
    expect(text).toContain("Current pipelines (baseline only");
    expect(text).toContain("pipeline #20 success");
    expect(text).toContain("commit abc123");
    expect(text).not.toContain("No pipelines match");
  });
});
