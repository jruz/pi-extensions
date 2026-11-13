import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each([0, 7])(
  "forwards large stderr output without blocking or polluting stdout on exit %i",
  (exitCode) => {
    const result = spawnSync(
      process.execPath,
      ["tests/fixtures/subprocess.ts", String(exitCode)],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(result.stdout).toBe('{"status":"complete"}');
    const diagnostics = "diagnostic\n".repeat(262144);
    expect(result.stderr).toBe(diagnostics);
  },
);
