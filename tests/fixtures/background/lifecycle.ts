import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { log } from "./log.ts";

const runtimeKey = Symbol.for("agent-config.background.phase1-runtime");
const runtimeSchema = z.object({ id: z.uuid() }).readonly();

const runtimeId = (): string => {
  const existing: unknown = Reflect.get(globalThis, runtimeKey);
  if (existing !== undefined) return runtimeSchema.parse(existing).id;
  const runtime = { id: randomUUID() };
  Reflect.set(globalThis, runtimeKey, runtime);
  return runtime.id;
};

export default (pi: ExtensionAPI): void => {
  pi.registerFlag("background-probe-output", { type: "string" });
  const record = async (type: string, reason: string): Promise<void> => {
    const outputPath = pi.getFlag("background-probe-output");
    if (typeof outputPath !== "string")
      throw new Error("probe output: required");
    try {
      await appendFile(
        outputPath,
        `${JSON.stringify({ type, reason, runtimeId: runtimeId() })}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      log.error(`lifecycle probe: ${String(error)}`);
      throw error;
    }
  };

  pi.on("session_start", async (event) => {
    await record("start", event.reason);
  });
  pi.on("session_shutdown", async (event) => {
    await record("shutdown", event.reason);
    if (event.reason === "quit") Reflect.deleteProperty(globalThis, runtimeKey);
  });
  pi.registerCommand("background-probe-quit", {
    description: "Finish the isolated lifecycle probe",
    handler: (_args, ctx) => {
      ctx.shutdown();
      return Promise.resolve();
    },
  });
};
