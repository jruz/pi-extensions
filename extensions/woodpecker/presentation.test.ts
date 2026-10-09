import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  pipelineStyle,
  renderNotification,
  updateLines,
  type CardTheme,
} from "./presentation.ts";
import type { PipelineUpdate } from "./notifications.ts";

const theme: CardTheme = {
  fg: (color, text) => `[${color}]${text}`,
  bg: (_color, text) => text,
  bold: (text) => text,
};
const pipeline = {
  id: 10,
  number: 10,
  status: "failure",
  branch: "main",
  commit: "abc1234567",
};
const failure: PipelineUpdate = {
  kind: "failure",
  diagnostics: {
    repo: "owner/repo",
    pipeline,
    steps: [
      {
        workflow: "build-main",
        name: "BUILD",
        number: 6,
        exitCode: 1,
        error: "",
        started: 100,
        stopped: 113,
        evidence: [
          { line: 20, text: "context" },
          { line: 21, text: "error: denied" },
        ],
        logsCommand: "woodpecker-cli pipeline log show 'owner/repo' 10 6",
      },
    ],
  },
};

describe("reviewed Woodpecker cards", () => {
  it.each([
    ["success", "success", "✓ Woodpecker CI · Passed"],
    ["failure", "error", "✗ Woodpecker CI · Failed"],
    ["running", "accent", "● Woodpecker CI · Running"],
    ["pending", "muted", "○ Woodpecker CI · Pending"],
  ])("styles %s without warning orange", (status, color, title) => {
    const style = pipelineStyle(status);
    expect(style).toEqual({ color, title });
  });

  it("keeps unreviewed status values visible rather than claiming success", () => {
    const style = pipelineStyle("killed");
    expect(style.title).toContain("killed");
    expect(style.color).toBe("muted");
  });

  it("shows error-only lines with a blank before each failed step", () => {
    const lines = updateLines(failure, theme);
    expect(lines[2]).toBe("");
    const text = lines.join("\n");
    expect(text).toContain("build-main / BUILD · exit 1 · 13s");
    expect(text).toContain("L21: error: denied");
    expect(text).not.toContain("L20: context");
    expect(text).toContain("log show 'owner/repo' 10 6");
    expect(text).toContain("abc1234");
  });

  it("distinguishes unavailable diagnostics from CI success", () => {
    const update: PipelineUpdate = {
      kind: "diagnostics-unavailable",
      repo: "owner/repo",
      pipeline,
      reason: "request timeout",
    };
    const lines = updateLines(update, theme);
    const text = lines.join("\n");
    expect(text).toContain("[error]✗ Woodpecker CI · Failed");
    expect(text).toContain("Failed-step diagnostics unavailable");
    expect(text).toContain("log show 'owner/repo' 10");
  });

  it("identifies a branchless tag pipeline in its card", () => {
    const update: PipelineUpdate = {
      kind: "status",
      repo: "owner/repo",
      pipeline: {
        ...pipeline,
        branch: "",
        event: "tag",
        ref: "refs/tags/v0.4.3",
      },
    };
    const lines = updateLines(update, theme);
    const text = lines.join("\n");
    expect(text).toContain("owner/repo · v0.4.3 · tag · #10");
  });

  it("removes terminal controls from API metadata", () => {
    const update: PipelineUpdate = {
      kind: "status",
      repo: "owner/repo",
      pipeline: {
        ...pipeline,
        status: "running",
        branch: "main\u001b[31m\ninjected",
      },
    };
    const lines = updateLines(update, theme);
    const text = lines.join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("main injected");
  });

  it("wraps cards within the terminal width", () => {
    const component = renderNotification({ updates: [failure] }, theme, 1);
    const lines = component.render(40);
    const widths = lines.map(visibleWidth);
    const withinWidth = widths.every((width) => width <= 40);
    expect(withinWidth).toBe(true);
  });
});
