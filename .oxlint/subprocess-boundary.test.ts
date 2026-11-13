import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

const cases = [
  {
    name: "direct spawn",
    code: 'import { spawn } from "node:child_process"; export const child = spawn("true");',
    status: 1,
  },
  {
    name: "aliased spawn",
    code: 'import { spawn as start } from "child_process"; export const child = start("true");',
    status: 1,
  },
  {
    name: "namespace import",
    code: 'import * as subprocess from "node:child_process"; export const child = subprocess.spawn("true");',
    status: 1,
  },
  {
    name: "default import",
    code: 'import subprocess from "node:child_process"; export const child = subprocess.spawn("true");',
    status: 1,
  },
  {
    name: "shared runner",
    code: 'import { spawnWithDiagnostics } from "../../lib/subprocess.ts"; const diagnostics: Buffer[] = []; export const child = spawnWithDiagnostics("true", [], (chunk) => { diagnostics.push(chunk); });',
    status: 0,
  },
  {
    name: "type-only import",
    code: 'import type { ChildProcess } from "node:child_process"; export type Child = ChildProcess;',
    status: 0,
  },
];

await it("enforces the subprocess import boundary with the real Oxlint config", () => {
  const prefix = join("extensions", "subprocess-lint-");
  const directory = mkdtempSync(prefix);
  try {
    cases.forEach((testCase, index) => {
      const path = join(directory, `case-${index}.ts`);
      writeFileSync(path, testCase.code);
      const result = spawnSync(
        process.execPath,
        ["node_modules/oxlint/bin/oxlint", "--config", ".oxlintrc.json", path],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(
        result.status,
        testCase.status,
        `${testCase.name}: ${result.stdout}${result.stderr}`,
      );
      if (testCase.status === 1) {
        assert.match(result.stdout, /no-restricted-imports/u);
      }
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
});
