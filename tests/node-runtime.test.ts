import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("loads Pi extensions with Node's native TypeScript support", async () => {
  const result = await execFileAsync(process.execPath, [
    "tests/fixtures/node-runtime.ts",
  ]);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
