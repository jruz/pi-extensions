import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  monitoringLines,
  monitoringSample,
  renderMonitoringPreview,
} from "./monitoring.ts";
import type { CardTheme } from "../woodpecker/presentation.ts";

const theme: CardTheme = {
  fg: (color, text) => `[${color}]${text}`,
  bg: (_color, text) => text,
  bold: (text) => text,
};

describe("monitoring-error preview", () => {
  it("distinguishes a stopped monitor from a failed build", () => {
    const lines = monitoringLines(monitoringSample, theme);
    const text = lines.join("\n");
    expect(text).toContain("Monitoring stopped");
    expect(text).toContain("Request timed out");
    expect(text).toContain("#42 running");
    expect(text).toContain("may be stale");
    expect(text).not.toContain("· Failed");
    expect(text).toContain("View current status:");
    expect(text).not.toContain("(terminal)");
    expect(text).toContain(
      "woodpecker-cli pipeline ls 'owner/repo' --branch 'main' --limit 1",
    );
    expect(text).toContain("Resume monitoring:");
    expect(text).not.toContain("(agent tool)");
    expect(text).toContain(
      'woodpecker_watch({"repo":"owner/repo","branch":"main"})',
    );
    expect(text).toContain("Sample data");
  });

  it("does not invent a pipeline when no snapshot exists", () => {
    const lines = monitoringLines(
      { ...monitoringSample, lastPipeline: null },
      theme,
    );
    const text = lines.join("\n");
    expect(text).toContain("No last-known pipeline status available");
    expect(text).not.toContain("#42");
  });

  it("wraps the card within the terminal width", () => {
    const card = renderMonitoringPreview(monitoringSample, theme);
    const lines = card.render(40);
    const widths = lines.map(visibleWidth);
    const withinWidth = widths.every((width) => width <= 40);
    expect(withinWidth).toBe(true);
  });
});
