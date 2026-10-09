import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile } from "node:fs/promises";
import { log } from "./log.ts";
const outputPath = process.argv[2];
if (outputPath === undefined) throw new Error("output path: required");

const child = spawn("sleep", ["30"], { stdio: "ignore" });
await once(child, "spawn").catch((error: unknown) => {
  const message = String(error);
  log.error(`fixture spawn: ${message}`);
  throw error;
});
await appendFile(outputPath, `child-pid=${child.pid}\n`, { mode: 0o600 });
log.info("parent-exit");
process.exit(0);
