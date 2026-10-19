import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextImmediate } from "node:timers/promises";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import contextHandoff from "../extensions/context-handoff.ts";

const cleanups: (() => Promise<void>)[] = [];
const failedStopReasons: AssistantMessage["stopReason"][] = [
  "error",
  "aborted",
];

const expectPlan = (path: string, expected: string): void => {
  try {
    const content = readFileSync(path, "utf8");
    expect(content).toBe(expected);
  } catch (error) {
    const warning = new Error("handoff verification failed", { cause: error });
    process.emitWarning(warning);
    throw error;
  }
};

const start = async (extensions: ExtensionFactory[] = [contextHandoff]) => {
  const temporaryDirectory = tmpdir();
  const prefix = join(temporaryDirectory, "pi-handoff-");
  const directory = await mkdtemp(prefix);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: extensions,
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models-cache.json"),
    refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: "handoff-test" }] });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(directory),
  });
  const shutdown = vi.fn();
  const errors = vi.fn();
  await session.bindExtensions({ shutdownHandler: shutdown, onError: errors });
  const usage = vi.spyOn(session, "getContextUsage");
  usage.mockReturnValue({ tokens: 800, contextWindow: 1000, percent: 80 });
  cleanups.push(async () => {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { session, faux, shutdown, errors, directory, usage };
};

const writePlan = (content: string) => {
  const call = fauxToolCall("write", { path: "PLAN.md", content });
  return fauxAssistantMessage(call);
};

const expectHandoffCount = (
  runtime: Awaited<ReturnType<typeof start>>,
  count: number,
): void => {
  const entries = runtime.session.sessionManager.getBranch();
  const handoffs = entries.filter(
    (entry) =>
      entry.type === "custom_message" && entry.customType === "context-handoff",
  );
  expect(handoffs).toHaveLength(count);
};

const finish = async (runtime: Awaited<ReturnType<typeof start>>) => {
  await runtime.session.prompt("continue implementation");
  await nextImmediate();
  expect(runtime.errors).not.toHaveBeenCalled();
};

afterEach(async () => {
  const actions = cleanups.splice(0).map((cleanup) => cleanup());
  await Promise.all(actions);
});

describe("context handoff", () => {
  it("finishes writing PLAN.md before requesting shutdown", async () => {
    const runtime = await start();
    const planPath = join(runtime.directory, "PLAN.md");
    runtime.shutdown.mockImplementation(() => {
      expectPlan(planPath, "handoff saved");
    });
    runtime.faux.setResponses([
      fauxAssistantMessage("regular work"),
      (context) => {
        expect(runtime.shutdown).not.toHaveBeenCalled();
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain("Stop regular work now");
        return writePlan("handoff saved");
      },
      fauxAssistantMessage("handoff complete"),
    ]);
    await finish(runtime);
    expectPlan(planPath, "handoff saved");
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expectHandoffCount(runtime, 1);
  });

  it.each([79, null, undefined])(
    "does not hand off at %s percent",
    async (percent) => {
      const runtime = await start();
      const usage =
        percent === undefined
          ? undefined
          : { tokens: null, contextWindow: 1000, percent };
      runtime.usage.mockReturnValue(usage);
      runtime.faux.setResponses([fauxAssistantMessage("done")]);
      await finish(runtime);
      expect(runtime.shutdown).not.toHaveBeenCalled();
      expectHandoffCount(runtime, 0);
      expect(runtime.faux.state.callCount).toBe(1);
    },
  );

  it("preserves earlier boundary entries without reinjecting the handoff", async () => {
    const earlier: ExtensionFactory = (pi) => {
      pi.on("turn_end", (event) => ({
        entries: [
          ...event.entries,
          { type: "custom", customType: "earlier-boundary" },
        ],
      }));
    };
    const runtime = await start([earlier, contextHandoff]);
    runtime.faux.setResponses([
      fauxAssistantMessage("done"),
      writePlan("saved"),
      fauxAssistantMessage("saved"),
    ]);
    await finish(runtime);
    const entries = runtime.session.sessionManager.getBranch();
    const earlierEntries = entries.filter(
      (entry) =>
        entry.type === "custom" && entry.customType === "earlier-boundary",
    );
    expect(earlierEntries).toHaveLength(3);
    expectHandoffCount(runtime, 1);
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });

  it.each(failedStopReasons)(
    "does not start a handoff after an %s turn",
    async (stopReason) => {
      const runtime = await start();
      runtime.faux.setResponses([
        fauxAssistantMessage("failed", {
          stopReason,
          errorMessage: "test failure",
        }),
      ]);
      await finish(runtime);
      expectHandoffCount(runtime, 0);
      expect(runtime.shutdown).not.toHaveBeenCalled();
      expect(runtime.faux.state.callCount).toBe(1);
    },
  );

  it.each(failedStopReasons)(
    "does not shut down or restart after handoff %s",
    async (stopReason) => {
      const runtime = await start();
      runtime.faux.setResponses([
        fauxAssistantMessage("done"),
        fauxAssistantMessage("failed", {
          stopReason,
          errorMessage: "test failure",
        }),
      ]);
      await finish(runtime);
      expectHandoffCount(runtime, 1);
      expect(runtime.shutdown).not.toHaveBeenCalled();
      expect(runtime.faux.state.callCount).toBe(2);
    },
  );

  it("honors Stop during the handoff request", async () => {
    const runtime = await start();
    const aborts: Promise<void>[] = [];
    runtime.faux.setResponses([
      fauxAssistantMessage("done"),
      () => {
        const aborted = runtime.session.abort();
        aborts.push(aborted);
        return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
      },
    ]);
    await finish(runtime);
    await Promise.all(aborts);
    expect(runtime.shutdown).not.toHaveBeenCalled();
    expect(runtime.faux.state.callCount).toBe(2);
  });

  it("waits for existing stop-hook corrective follow-ups before shutdown", async () => {
    let checks = 0;
    const stopHook: ExtensionFactory = (pi) => {
      pi.on("agent_settled", async () => {
        await nextImmediate();
        checks += 1;
        if (checks !== 1) return;
        pi.sendUserMessage(
          "The stop checks failed. Correct PLAN.md before finishing.",
        );
      });
    };
    const runtime = await start([stopHook, contextHandoff]);
    const planPath = join(runtime.directory, "PLAN.md");
    runtime.shutdown.mockImplementation(() => {
      expectPlan(planPath, "corrected handoff");
    });
    runtime.faux.setResponses([
      fauxAssistantMessage("done"),
      writePlan("initial handoff"),
      fauxAssistantMessage("handoff saved"),
      () => {
        expect(runtime.shutdown).not.toHaveBeenCalled();
        return writePlan("corrected handoff");
      },
      fauxAssistantMessage("corrected"),
    ]);
    await finish(runtime);
    expect(checks).toBe(2);
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expectHandoffCount(runtime, 1);
  });

  it("resets for session replacement", async () => {
    const runtime = await start();
    runtime.faux.setResponses([
      fauxAssistantMessage("done"),
      writePlan("old session handoff"),
      fauxAssistantMessage("saved"),
    ]);
    await finish(runtime);
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    runtime.shutdown.mockClear();
    runtime.session.sessionManager.newSession();
    runtime.session.agent.state.messages = [];
    await runtime.session.extensionRunner.emit({
      type: "session_start",
      reason: "new",
    });
    runtime.faux.setResponses([
      fauxAssistantMessage("new work"),
      writePlan("new session handoff"),
      fauxAssistantMessage("saved"),
    ]);
    await finish(runtime);
    expectHandoffCount(runtime, 1);
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });

  it("cancels a scheduled shutdown when the session closes", async () => {
    const closeSession: ExtensionFactory = (pi) => {
      pi.on("agent_settled", async () => {
        await runtime.session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      });
    };
    const runtime = await start([contextHandoff, closeSession]);
    runtime.faux.setResponses([
      fauxAssistantMessage("done"),
      fauxAssistantMessage("saved"),
    ]);
    await finish(runtime);
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("keeps independent extension instances isolated", async () => {
    const first = await start();
    const second = await start();
    const run = async (runtime: Awaited<ReturnType<typeof start>>) => {
      runtime.faux.setResponses([
        fauxAssistantMessage("done"),
        writePlan("saved"),
        fauxAssistantMessage("saved"),
      ]);
      await finish(runtime);
      expectHandoffCount(runtime, 1);
      expect(runtime.shutdown).toHaveBeenCalledOnce();
    };
    await run(first);
    await run(second);
  });
});
