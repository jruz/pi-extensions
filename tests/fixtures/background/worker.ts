import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { log } from "./log.ts";

const outputPath = process.argv[2];
if (outputPath === undefined) throw new Error("output path: required");

const write = async (line: string): Promise<void> => {
  try {
    await appendFile(outputPath, `${line}\n`, { mode: 0o600 });
    log.info(line);
  } catch (error) {
    log.error(`fixture write: ${String(error)}`);
    throw error;
  }
};

const fail = (error: unknown): void => {
  log.error(`fixture input: ${String(error)}`);
  process.exitCode = 1;
  input.close();
  process.stdin.destroy();
};

const handleLine = async (line: string): Promise<void> => {
  if (line !== "exit") {
    await write(`input=${JSON.stringify(line)}`);
    return;
  }
  await write("final");
  process.exitCode = 7;
  input.close();
  process.stdin.destroy();
};

const input = createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  handleLine(line).catch(fail);
});
process.on("SIGINT", () => {
  write("sigint").catch(fail);
});

await write(`pid=${process.pid}`);
await write(`cwd=${process.cwd()}`);
await write("ready");
