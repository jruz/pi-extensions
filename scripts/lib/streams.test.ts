import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const runHelper = (module: URL, statement: string) => {
  const specifier = JSON.stringify(module.href);
  const source = `import * as helper from ${specifier}; ${statement}`;
  const result = spawnSync("bun", ["--eval", source], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  return result;
};

test("all diagnostic levels write only to stderr", () => {
  const result = runHelper(
    new URL("./log.ts", import.meta.url),
    `
    helper.log.info("starting");
    helper.log.warn("review");
    helper.log.ok("done");
    helper.log.error("failed");
  `,
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "[\x1b[34mINFO\x1b[0m] starting\n" +
      "[\x1b[33mWARN\x1b[0m] review\n" +
      "[\x1b[32mOK\x1b[0m] done\n" +
      "[\x1b[31mERROR\x1b[0m] failed\n",
  );
});

test("text output writes only to stdout", () => {
  const result = runHelper(
    new URL("./output.ts", import.meta.url),
    'helper.output.text("result");',
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("result\n");
  expect(result.stderr).toBe("");
});

test("JSON output is formatted without diagnostic text", () => {
  const result = runHelper(
    new URL("./output.ts", import.meta.url),
    'helper.output.json({status: "ok", count: 2});',
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('{\n  "status": "ok",\n  "count": 2\n}\n');
  expect(result.stderr).toBe("");
});

test("table output writes the rendered table only to stdout", () => {
  const result = runHelper(
    new URL("./output.ts", import.meta.url),
    'helper.output.table(["NAME"], [["Bun"]]);',
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    "┌──────┐\n│ NAME │\n├──────┤\n│ Bun  │\n└──────┘\n",
  );
  expect(result.stderr).toBe("");
});
