import { z } from "zod";
import { spawnWithDiagnostics } from "../../lib/subprocess.ts";
import { log } from "./background/log.ts";

const exitCode = z.coerce.number().int().parse(process.argv[2]);
const script = `process.stdout.write('{"status":"complete"}'); process.stderr.write('diagnostic\\n'.repeat(262144), () => { process.exitCode = ${exitCode}; });`;
const diagnostics: Buffer[] = [];
const child = spawnWithDiagnostics(
  process.execPath,
  ["--eval", script],
  (chunk) => diagnostics.push(chunk),
);

child.stdin.end();
child.stdout.pipe(process.stdout);
child.once("error", (error) => {
  throw error;
});
child.once("close", (code) => {
  if (code === null) throw new Error("subprocess: closed without an exit code");
  const text = Buffer.concat(diagnostics).toString("utf8").trimEnd();
  log.error(text);
  process.exitCode = code;
});
