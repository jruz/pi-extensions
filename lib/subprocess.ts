import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type Subprocess = ChildProcessByStdio<Writable, Readable, Readable>;

export type DiagnosticListener = (chunk: Buffer) => void;

export const spawnWithDiagnostics = (
  command: string,
  args: readonly string[],
  onDiagnostic: DiagnosticListener,
): Subprocess => {
  const child = spawn(command, args, { stdio: "pipe" });
  child.stderr.on("data", onDiagnostic);
  return child;
};
