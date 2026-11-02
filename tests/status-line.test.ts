import { describe, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolvePiLogDirectory } from "../extensions/shared/log-path.ts";
import {
  formatDisplayPath,
  formatDuration,
  formatPercent,
  formatTokens,
  contextBarColor,
  modelColor,
  modelNameParts,
  parsePlanProgress,
  parseUsageCache,
  parseUsageLimits,
  renderProgressBar,
  renderColoredBar,
  renderRuntimeLine,
} from "../extensions/status-line.ts";

describe("Pi log path", () => {
  test("uses XDG_STATE_HOME when configured", () => {
    const directory = resolvePiLogDirectory("/state", "/home/user");
    expect(directory).toBe("/state/pi/log");
  });

  test("falls back to the user state directory", () => {
    const unsetDirectory = resolvePiLogDirectory(undefined, "/home/user");
    const relativeDirectory = resolvePiLogDirectory("state", "/home/user");
    expect(unsetDirectory).toBe("/home/user/.local/state/pi/log");
    expect(relativeDirectory).toBe("/home/user/.local/state/pi/log");
  });
});

describe("status line formatting", () => {
  test("renders unavailable progress", () => {
    const bar = renderProgressBar(undefined);
    const percent = formatPercent(undefined);
    expect(bar).toBe("──────────");
    expect(percent).toBe("--");
  });

  test("renders empty, partial, and full progress", () => {
    const empty = renderProgressBar(0);
    const tiny = renderProgressBar(4);
    const partial = renderProgressBar(45);
    const full = renderProgressBar(100);
    expect(empty).toBe("──────────");
    expect(tiny).toBe("━─────────");
    expect(partial).toBe("━━━━━─────");
    expect(full).toBe("━━━━━━━━━━");
  });

  test("colors named models and other models", () => {
    const terra = modelColor("gpt-5.6-terra");
    const sol = modelColor("gpt-5.6-sol");
    const astra = modelColor("gpt-5.6-astra");
    const other = modelColor("gpt-5.6-other");
    const extended = modelColor("gpt-5.6-terra-extra");
    expect(terra).toBe("accent");
    expect(sol).toBe("warning");
    expect(astra).toBe("error");
    expect(other).toBe("purple");
    expect(extended).toBe("purple");
  });

  test("colors model prefix and suffix independently", () => {
    const terra = modelNameParts("gpt-5.6-terra");
    const sol = modelNameParts("gpt-5.6-sol");
    const olderGpt = modelNameParts("gpt-4o-mini");
    const futureGpt = modelNameParts("gpt-6-astra");
    const claude = modelNameParts("claude");
    expect(terra).toEqual({
      prefix: "gpt-5.6-",
      suffix: "terra",
      color: "accent",
    });
    expect(sol).toEqual({
      prefix: "gpt-5.6-",
      suffix: "sol",
      color: "warning",
    });
    expect(olderGpt).toEqual({
      prefix: "gpt-4o-",
      suffix: "mini",
      color: "purple",
    });
    expect(futureGpt).toEqual({
      prefix: "gpt-6-",
      suffix: "astra",
      color: "error",
    });
    expect(claude).toEqual({
      prefix: "claude",
      suffix: "",
      color: "purple",
    });
  });

  test("renders colored bars with separate filled and empty colors", () => {
    const bar = renderColoredBar(
      (color, text) => `<${color}>${text}</${color}>`,
      45,
      "success",
    );
    const tiny = renderColoredBar(
      (color, text) => `<${color}>${text}</${color}>`,
      4,
      "accent",
    );
    expect(bar).toBe("<success>━━━━━</success><dim>─────</dim>");
    expect(tiny).toBe("<accent>━</accent><dim>─────────</dim>");
  });

  test("colors context usage by threshold", () => {
    const belowWarning = contextBarColor(49);
    const warningStart = contextBarColor(50);
    const warningEnd = contextBarColor(69);
    const errorStart = contextBarColor(70);
    const unavailable = contextBarColor(undefined);
    expect(belowWarning).toBe("success");
    expect(warningStart).toBe("warning");
    expect(warningEnd).toBe("warning");
    expect(errorStart).toBe("error");
    expect(unavailable).toBe("dim");
  });

  test("formats percentages and tokens", () => {
    const percent = formatPercent(12.4);
    const small = formatTokens(999);
    const thousands = formatTokens(12_345);
    const millions = formatTokens(1_234_567);
    expect(percent).toBe("12%");
    expect(small).toBe("999");
    expect(thousands).toBe("12.3k");
    expect(millions).toBe("1.2m");
  });

  test("parses the normalized shared usage cache", () => {
    const cache = parseUsageCache({
      fetchedAt: 1_700_000_000_000,
      limits: {
        fiveHour: {
          remainingPercent: 80,
          windowMinutes: 300,
          resetsAt: 1_700_000_000,
        },
        weekly: {},
      },
    });
    expect(cache).toEqual({
      fetchedAt: 1_700_000_000_000,
      limits: {
        fiveHour: {
          remainingPercent: 80,
          windowMinutes: 300,
          resetsAt: 1_700_000_000,
        },
        weekly: {
          remainingPercent: undefined,
          windowMinutes: undefined,
          resetsAt: undefined,
        },
      },
    });
  });

  test("parses sanitized account limits", () => {
    const payload = {
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_at: 1_700_000_000,
        },
        secondary_window: {
          used_percent: 40,
          limit_window_seconds: 604_800,
          reset_at: 1_700_000_000,
        },
      },
    };
    const limits = parseUsageLimits(payload);
    const expected = {
      fiveHour: {
        remainingPercent: 80,
        windowMinutes: 300,
        resetsAt: 1_700_000_000,
      },
      weekly: {
        remainingPercent: 60,
        windowMinutes: 10_080,
        resetsAt: 1_700_000_000,
      },
    };
    const invalidPayload = { rate_limit: "invalid" };
    const unavailablePayload = { rate_limit: null };
    const parseInvalidPayload = () => parseUsageLimits(invalidPayload);
    const duration = formatDuration(1_700_000_000, 1_699_996_400_000);
    const unavailableLimits = parseUsageLimits(unavailablePayload);
    expect(limits).toEqual(expected);
    expect(unavailableLimits).toEqual({
      fiveHour: {
        remainingPercent: undefined,
        windowMinutes: undefined,
        resetsAt: undefined,
      },
      weekly: {
        remainingPercent: undefined,
        windowMinutes: undefined,
        resetsAt: undefined,
      },
    });
    expect(parseInvalidPayload).toThrow("usage rate limit is not an object");
    expect(duration).toBe("1h");
  });

  test("counts plan checkboxes", () => {
    const progress = parsePlanProgress(
      "- [x] done\n- [ ] next\n- [X] also done",
    );
    const empty = parsePlanProgress("no tasks");
    expect(progress).toEqual({ completed: 2, total: 3 });
    expect(empty).toEqual({ completed: 0, total: 0 });
  });

  test("formats the runtime path with its final two directories", () => {
    const path = formatDisplayPath("/home/jruz/dev/projects/agent-config");
    expect(path).toBe(".../projects/agent-config");
  });

  test("renders the process count and runtime path", () => {
    const theme = (_color: string, text: string) => text;
    const idle = renderRuntimeLine(theme, "/work/project", 0, undefined, 80);
    const running = renderRuntimeLine(theme, "/work/project", 2, "tool ✓", 80);
    const idleText = idle.trimEnd();
    const runningText = running.trimEnd();
    expect(idleText).toContain("Process: 0");
    expect(idle).toContain("Hooks:");
    expect(idle).not.toContain("Hooks: idle");
    expect(idle).toContain("Path: .../work/project");
    expect(runningText).toContain("Process: 2");
    expect(running).toContain("Hooks: tool ✓");
  });

  test("truncates the runtime line to the terminal width", () => {
    const theme = (_color: string, text: string) => text;
    const line = renderRuntimeLine(
      theme,
      "/a/very/long/working/path",
      1,
      undefined,
      20,
    );
    const lineWidth = visibleWidth(line);
    expect(lineWidth).toBeLessThanOrEqual(20);
    expect(line).toContain("...");
  });
});
