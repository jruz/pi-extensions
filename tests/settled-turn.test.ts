import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { lastTurnFailed } from "../extensions/shared/settled-turn.ts";

const usage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistantEntry = (id: string, stopReason: StopReason): SessionEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-10-04T09:37:27.013Z",
  message: {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-6-luna",
    usage,
    stopReason,
    timestamp: 0,
  },
});

const userEntry = (id: string): SessionEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-10-04T09:37:27.127Z",
  message: { role: "user", content: "stop checks failed", timestamp: 0 },
});

const modelChangeEntry: SessionEntry = {
  type: "model_change",
  id: "model",
  parentId: null,
  timestamp: "2026-10-04T09:19:44.270Z",
  provider: "openai-codex",
  modelId: "gpt-6-luna",
};

describe("last turn failure detection", () => {
  test.each<StopReason>(["error", "aborted"])(
    "detects a last assistant turn ending with %s",
    (stopReason) => {
      const entries = [
        assistantEntry("first", "stop"),
        userEntry("prompt"),
        assistantEntry("last", stopReason),
      ];
      const failed = lastTurnFailed(entries);
      expect(failed).toBe(true);
    },
  );

  test.each<StopReason>(["stop", "toolUse", "length"])(
    "allows stop checks after a turn ending with %s",
    (stopReason) => {
      const entries = [
        assistantEntry("first", "error"),
        assistantEntry("last", stopReason),
      ];
      const failed = lastTurnFailed(entries);
      expect(failed).toBe(false);
    },
  );

  test("uses the last assistant turn when later entries are not assistant messages", () => {
    const entries = [
      assistantEntry("last", "error"),
      userEntry("retry"),
      modelChangeEntry,
    ];
    const failed = lastTurnFailed(entries);
    expect(failed).toBe(true);
  });

  test("allows stop checks when no assistant turn exists", () => {
    const entries = [modelChangeEntry, userEntry("prompt")];
    const failed = lastTurnFailed(entries);
    expect(failed).toBe(false);
  });
});
