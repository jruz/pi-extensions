import { writeFile } from "node:fs/promises";
import { log } from "./log.ts";

const outputPath = process.argv[2];
if (outputPath === undefined) throw new Error("output path: required");
const marker = process.env["AGENT_CONFIG_PHASE1_TEST_MARKER"];
if (marker !== "first" && marker !== "later")
  throw new Error("test marker: first or later required");

try {
  const context = JSON.stringify({ cwd: process.cwd(), marker });
  await writeFile(outputPath, context, { mode: 0o600 });
} catch (error) {
  log.error(`launch context: ${String(error)}`);
  throw error;
}
