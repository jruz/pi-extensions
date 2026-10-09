import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createCliRunner } from "./cli.ts";

describe("Woodpecker diagnostic CLI requests", () => {
  it("passes arguments, cancellation and a timeout without invoking a shell", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>();
    exec.mockResolvedValue({
      stdout: "output",
      stderr: "",
      code: 0,
      killed: false,
    });
    const signal = new AbortController().signal;
    const run = createCliRunner(exec, signal);
    const text = await run(["pipeline", "ps", "owner/repo", "10"]);
    expect(text).toBe("output");
    expect(exec).toHaveBeenCalledWith(
      "woodpecker-cli",
      ["--disable-update-check", "pipeline", "ps", "owner/repo", "10"],
      { signal, timeout: 30000 },
    );
  });

  it("does not claim a cancelled request succeeded", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>();
    exec.mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: true });
    const run = createCliRunner(exec, undefined);
    const request = run(["pipeline", "ps", "owner/repo", "10"]);
    await expect(request).rejects.toThrow("interrupted or timed out");
  });

  it("reports nonzero exits with sanitized error evidence", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>();
    exec.mockResolvedValue({
      stdout: "",
      stderr: "error: request failed\nTOKEN=example-value",
      code: 1,
      killed: false,
    });
    const run = createCliRunner(exec, undefined);
    const request = run(["pipeline", "ps", "owner/repo", "10"]);
    await expect(request).rejects.toThrow("Woodpecker CLI exited 1");
    await expect(request).rejects.toThrow("error: request failed");
    await expect(request).rejects.not.toThrow("example-value");
  });
});
