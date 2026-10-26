import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PI_LOG_DIRECTORY } from "./log-path.ts";

const LOG_PATH = resolve(PI_LOG_DIRECTORY, "pi-extensions.log");

export const logError = async (
  scope: string,
  error: unknown,
  context: Readonly<{ cwd: string; operation: string }>,
): Promise<void> => {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const timestamp = new Date().toISOString();
    const entry = JSON.stringify({ timestamp, scope, ...context, message });
    await mkdir(PI_LOG_DIRECTORY, { recursive: true });
    await appendFile(LOG_PATH, `${entry}\n`);
  } catch (error) {
    process.emitWarning("extension error logging failed", "ExtensionLogError");
    throw error;
  }
};
