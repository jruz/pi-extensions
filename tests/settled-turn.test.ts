import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { lastTurnFailed } from "../extensions/shared/settled-turn.ts";

const usage: AssistantMessage["usage"] = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
};

const assistantEntry = (id: string, stopReason: StopReason): SessionEntry => ({
  id,
  message: {
    api: "openai-codex-responses",
    content: [],
    model: "gpt-6-luna",
    provider: "openai-codex",
    role: "assistant",
    stopReason,
    timestamp: 0,
    usage,
  },
  parentId: null,
  timestamp: "2026-10-04T09:37:27.013Z",
  type: "message",
});

const userEntry = (id: string): SessionEntry => ({
  id,
  message: { content: "stop checks failed", role: "user", timestamp: 0 },
  parentId: null,
  timestamp: "2026-10-04T09:37:27.127Z",
  type: "message",
});

const modelChangeEntry: SessionEntry = {
  id: "model",
  modelId: "gpt-6-luna",
  parentId: null,
  provider: "openai-codex",
  timestamp: "2026-10-04T09:19:44.270Z",
  type: "model_change",
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
