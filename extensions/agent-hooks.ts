import { realpathSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { spawnWithDiagnostics } from "../lib/subprocess.ts";
import type { Subprocess } from "../lib/subprocess.ts";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  createHookStatus,
  type HookStatus,
} from "./shared/agent-hooks-status.ts";
import { PI_LOG_DIRECTORY } from "./shared/log-path.ts";
import { lastTurnFailed } from "./shared/settled-turn.ts";

type HookDecision = Readonly<{
  block: boolean;
  reason?: string;
}>;

type StopDecision = Readonly<{
  decision: "block";
  reason: string;
}>;

type HookFailure = Readonly<{
  kind: "start" | "exit" | "timeout";
  message: string;
  exitCode?: number;
  diagnostics?: string;
}>;

type HookResult =
  | Readonly<{ status: "success"; output: string }>
  | Readonly<{ status: "failure"; failure: HookFailure }>;

const HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const DIAGNOSTIC_TAIL_LENGTH = 4096;

const tailOf = (text: string): string => text.slice(-DIAGNOSTIC_TAIL_LENGTH);
const AGENT_HOOK_LOG_PATH = resolve(PI_LOG_DIRECTORY, "pi-agent-hooks.log");

const resolveHookDirectory = (): string => {
  const agentDirectory = getAgentDir();
  const hookLink = join(agentDirectory, "agent-config-hooks");
  try {
    return realpathSync(hookLink);
  } catch (error) {
    throw new Error(`missing hook directory: ${hookLink}`, { cause: error });
  }
};

const HOOK_DIRECTORY = resolveHookDirectory();
const piHook = (name: string): string => join(HOOK_DIRECTORY, name);

const isHookDecision = (value: unknown): value is HookDecision => {
  if (typeof value !== "object" || value === null) return false;
  const entries = Object.entries(value);
  const decision: Record<string, unknown> = Object.fromEntries(entries);
  if (typeof decision["block"] !== "boolean") return false;
  return (
    decision["reason"] === undefined || typeof decision["reason"] === "string"
  );
};

const isStopDecision = (value: unknown): value is StopDecision => {
  if (typeof value !== "object" || value === null) return false;
  const entries = Object.entries(value);
  const decision: Record<string, unknown> = Object.fromEntries(entries);
  return (
    decision["decision"] === "block" && typeof decision["reason"] === "string"
  );
};

const runHook = async (
  path: string,
  args: readonly string[],
  input?: string,
): Promise<HookResult> => {
  let diagnostics = "";
  const recordDiagnostic = (chunk: Buffer): void => {
    diagnostics = tailOf(diagnostics + chunk.toString("utf8"));
  };
  let child: Subprocess;
  try {
    child = spawnWithDiagnostics(path, args, recordDiagnostic);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { status: "failure", failure: { kind: "start", message } };
  }

  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();

  const result = await new Promise<HookResult>((resolve) => {
    let settled = false;
    const finish = (result: HookResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({
        status: "failure",
        failure: { kind: "timeout", message: "hook timed out", diagnostics },
      });
    }, HOOK_TIMEOUT_MS);
    child.once("error", (error) => {
      const message = error instanceof Error ? error.message : "unknown error";
      finish({ status: "failure", failure: { kind: "start", message } });
    });
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        finish({
          status: "success",
          output: Buffer.concat(chunks).toString("utf8").trim(),
        });
        return;
      }
      const failure =
        exitCode === null
          ? {
              kind: "exit" as const,
              message: "hook closed without an exit status",
              diagnostics,
            }
          : {
              kind: "exit" as const,
              message: "hook exited unsuccessfully",
              exitCode,
              diagnostics,
            };
      finish({ status: "failure", failure });
    });
  });
  return result;
};

const parseJson = (output: string): unknown => {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("hook returned invalid JSON");
  }
};

const logHookFailure = async (
  hook: string,
  lifecycle: string,
  operation: string,
  failure: HookFailure | Error,
): Promise<void> => {
  const message = failure instanceof Error ? failure.message : failure.message;
  const exitCode = (() => {
    if (failure instanceof Error) return "";
    if (failure.exitCode === undefined) return "";
    return ` exit_status=${failure.exitCode}`;
  })();
  const diagnostics = (() => {
    if (failure instanceof Error) return "";
    if (failure.diagnostics === undefined) return "";
    if (failure.diagnostics === "") return "";
    return ` diagnostics=${JSON.stringify(failure.diagnostics)}`;
  })();
  const line = `timestamp=${new Date().toISOString()} hook=${hook} lifecycle=${lifecycle} operation=${operation} failure=${JSON.stringify(message)}${exitCode}${diagnostics}\n`;
  try {
    await mkdir(PI_LOG_DIRECTORY, { recursive: true });
    await appendFile(AGENT_HOOK_LOG_PATH, line);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : "unknown error";
    process.emitWarning(
      `agent hook error logging failed: ${diagnostic}`,
      "AgentHooksError",
    );
  }
};

const reportFailure = async (
  hook: string,
  lifecycle: string,
  operation: string,
  failure: HookFailure | Error,
): Promise<void> => {
  await logHookFailure(hook, lifecycle, operation, failure);
};

const reportTimeoutToAgent = (
  pi: ExtensionAPI,
  hook: string,
  failure: HookFailure,
): void => {
  if (failure.kind !== "timeout") return;
  pi.sendUserMessage(
    `The ${hook} hook timed out after five minutes. Check the hook before continuing.`,
  );
};

const runHookWithStatus = async (
  hookStatus: HookStatus,
  ctx: ExtensionContext,
  generation: number,
  name: string,
  path: string,
  args: readonly string[],
  input?: string,
): Promise<HookResult> => {
  hookStatus.showPending(ctx, generation, name);
  const result = await runHook(path, args, input);
  const status = result.status === "success" ? "success" : "failure";
  hookStatus.showResult(ctx, generation, name, status);
  return result;
};

const runUserPromptSubmit = async (
  hookStatus: HookStatus,
  ctx: ExtensionContext,
  generation: number,
): Promise<HookResult> => {
  const path = piHook("on_input");
  return runHookWithStatus(hookStatus, ctx, generation, "input", path, []);
};

const runStop = async (
  hookStatus: HookStatus,
  ctx: ExtensionContext,
  generation: number,
): Promise<HookResult> => {
  const path = piHook("on_stop");
  return runHookWithStatus(hookStatus, ctx, generation, "stop", path, ["pi"]);
};

const runPreToolUse = async (
  hookStatus: HookStatus,
  ctx: ExtensionContext,
  generation: number,
  input: string,
): Promise<HookResult> => {
  const path = piHook("on_tool");
  return runHookWithStatus(
    hookStatus,
    ctx,
    generation,
    "tool",
    path,
    ["pi"],
    input,
  );
};

export default function (pi: ExtensionAPI): void {
  const hookStatus = createHookStatus(
    (callback, duration) => setTimeout(callback, duration),
    (timer) => {
      clearTimeout(timer);
    },
  );

  pi.on("session_start", (_event, ctx) => {
    hookStatus.startSession(ctx);
  });

  pi.on("session_shutdown", () => {
    hookStatus.stopSession();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return;
    const generation = hookStatus.currentGeneration();
    const result = await runUserPromptSubmit(hookStatus, ctx, generation);
    if (!hookStatus.isSessionActive(generation)) return;
    if (result.status === "failure") {
      await reportFailure("input", "input", "run", result.failure);
      if (!hookStatus.isSessionActive(generation)) return;
      reportTimeoutToAgent(pi, "input", result.failure);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const generation = hookStatus.currentGeneration();
    const input = JSON.stringify(event);
    const result = await runPreToolUse(hookStatus, ctx, generation, input);
    if (!hookStatus.isSessionActive(generation)) return { block: false };
    if (result.status === "failure") {
      await reportFailure("tool_call", "tool_call", "run", result.failure);
      if (!hookStatus.isSessionActive(generation)) return { block: false };
      reportTimeoutToAgent(pi, "tool_call", result.failure);
      return { block: false };
    }
    if (result.output === "") return { block: false };
    try {
      const parsed = parseJson(result.output);
      const validDecision = isHookDecision(parsed);
      if (!validDecision) throw new Error("hook returned an invalid response");
      return parsed.block ? parsed : { block: false };
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("unknown error");
      await reportFailure("tool_call", "tool_call", "parse", failure);
      return { block: false };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    if (lastTurnFailed(branch)) return;
    const generation = hookStatus.currentGeneration();
    const result = await runStop(hookStatus, ctx, generation);
    if (!hookStatus.isSessionActive(generation)) return;
    if (result.status === "failure") {
      await reportFailure(
        "agent_settled",
        "agent_settled",
        "run",
        result.failure,
      );
      if (!hookStatus.isSessionActive(generation)) return;
      if (result.failure.kind === "timeout") {
        reportTimeoutToAgent(pi, "agent_settled", result.failure);
      } else {
        pi.sendUserMessage(
          `Agent hook infrastructure failure (${result.failure.kind}: ${result.failure.message}); see ${AGENT_HOOK_LOG_PATH}.`,
        );
      }
      return;
    }
    if (result.output === "") return;
    try {
      const parsed = parseJson(result.output);
      if (!isStopDecision(parsed))
        throw new Error("hook returned an invalid stop response");
      pi.sendUserMessage(
        `The stop checks failed. Fix these issues before finishing:\n${parsed.reason}`,
      );
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("unknown error");
      await reportFailure("agent_settled", "agent_settled", "parse", failure);
      if (!hookStatus.isSessionActive(generation)) return;
      pi.sendUserMessage(
        `Agent hook protocol failure; see ${AGENT_HOOK_LOG_PATH}.`,
      );
    }
  });
}
