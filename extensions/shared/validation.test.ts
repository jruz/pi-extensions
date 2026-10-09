import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { parseJson } from "./validation.ts";

describe("parseJson", () => {
  it("parses valid JSON", () => {
    const parsed = parseJson('{"status":"running"}');
    expect(parsed).toEqual({ status: "running" });
  });

  it("preserves the syntax error when wrapping invalid JSON", () => {
    assert.throws(
      () => parseJson("{"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith("invalid JSON:") &&
        error.cause instanceof SyntaxError,
    );
  });
});
