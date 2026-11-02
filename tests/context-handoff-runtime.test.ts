import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  type ExtensionContext,
  type ExtensionError,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import contextHandoff from "../extensions/context-handoff.ts";

const cleanups: (() => Promise<void>)[] = [];
const continuation = "Read PLAN.md and continue the plan.";

const start = async (
  extensions: ExtensionFactory[],
  mode: ExtensionContext["mode"],
) => {
  const temporaryDirectory = tmpdir();
  const prefix = join(temporaryDirectory, "pi-handoff-runtime-");
  const directory = await mkdtemp(prefix);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models-cache.json"),
    refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: "handoff-runtime" }] });
  modelRuntime.registerNativeProvider(faux.provider);
  const sessions: AgentSession[] = [];
  const factory = vi.fn<CreateAgentSessionRuntimeFactory>(async (options) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir: directory,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: extensions,
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      ...(options.sessionStartEvent === undefined
        ? {}
        : { sessionStartEvent: options.sessionStartEvent }),
      model: faux.getModel(),
    });
    sessions.push(result.session);
    vi.spyOn(result.session, "getContextUsage").mockReturnValue({
      tokens: 800,
      contextWindow: 1000,
      percent: 80,
    });
    return { ...result, services, diagnostics: [] };
  });
  const runtime = await createAgentSessionRuntime(factory, {
    cwd: directory,
    agentDir: directory,
    sessionManager: SessionManager.inMemory(directory),
  });
  const errors = vi.fn<(error: ExtensionError) => void>();
  const shutdown = vi.fn<() => void>();
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const rebind = async () => {
    await runtime.session.bindExtensions({
      mode,
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        fork: (entryId, options) => runtime.fork(entryId, options),
        navigateTree: (entryId, options) =>
          runtime.session.navigateTree(entryId, options),
        switchSession: (path, options) => runtime.switchSession(path, options),
        reload: () => runtime.session.reload(),
      },
      uiContext: { ...runtime.session.extensionRunner.getUIContext(), notify },
      shutdownHandler: shutdown,
      onError: errors,
    });
  };
  runtime.setRebindSession(rebind);
  await rebind();
  cleanups.push(async () => {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    runtime,
    sessions,
    faux,
    directory,
    errors,
    shutdown,
    notify,
    factory,
  };
};

const writeFileMessage = (path: string, content: string) => {
  const call = fauxToolCall("write", { path, content });
  return fauxAssistantMessage(call);
};

const writePlan = (content: string) => writeFileMessage("PLAN.md", content);

const readPlan = () => {
  const call = fauxToolCall("read", { path: "PLAN.md" });
  return fauxAssistantMessage(call);
};

const expectFile = async (path: string, expected: string) => {
  try {
    const content = await readFile(path, "utf8");
    expect(content).toBe(expected);
  } catch (error) {
    const warning = new Error("handoff verification failed", { cause: error });
    process.emitWarning(warning);
    throw error;
  }
};

const expectNoContinuation = (session: AgentSession) => {
  const messages = JSON.stringify(session.messages);
  expect(messages).not.toContain(continuation);
};

const expectFreshContext = (messages: unknown) => {
  const text = JSON.stringify(messages);
  expect(text).toContain(continuation);
  expect(text).not.toContain("old conversation secret marker");
  expect(text).not.toContain("Stop regular work now");
};

afterEach(async () => {
  const actions = cleanups.splice(0).map((cleanup) => cleanup());
  await Promise.all(actions);
});

describe("automatic context handoff", () => {
  it.each<ExtensionContext["mode"]>(["tui", "rpc", "print", "json"])(
    "saves the plan before a fresh %s session reads it and continues twice",
    async (mode) => {
      const test = await start([contextHandoff], mode);
      const original = test.runtime.session;
      const planPath = join(test.directory, "PLAN.md");
      test.faux.setResponses([
        fauxAssistantMessage("old conversation secret marker"),
        writePlan("first saved plan"),
        fauxAssistantMessage("first handoff complete"),
        async (context) => {
          expectFreshContext(context.messages);
          await expectFile(planPath, "first saved plan");
          expect(test.runtime.session).not.toBe(original);
          return readPlan();
        },
        writeFileMessage("next-task.txt", "continued first task"),
        writePlan("second saved plan"),
        fauxAssistantMessage("second handoff complete"),
        async (context) => {
          expectFreshContext(context.messages);
          await expectFile(planPath, "second saved plan");
          vi.spyOn(test.runtime.session, "getContextUsage").mockReturnValue({
            tokens: 100,
            contextWindow: 1000,
            percent: 10,
          });
          return readPlan();
        },
        writeFileMessage("next-task.txt", "continued second task"),
        fauxAssistantMessage("continued successfully"),
      ]);
      await original.prompt("old conversation secret marker");
      expect(test.sessions).toHaveLength(3);
      const ids = test.sessions.map((session) =>
        session.sessionManager.getSessionId(),
      );
      const distinctIds = new Set(ids);
      expect(distinctIds.size).toBe(3);
      test.sessions.slice(1).forEach((session) => {
        const users = session.messages.filter(
          (message) => message.role === "user",
        );
        expect(users).toHaveLength(1);
        const serialized = JSON.stringify(users);
        expect(serialized).toContain(continuation);
      });
      const taskPath = join(test.directory, "next-task.txt");
      await expectFile(taskPath, "continued second task");
      expect(test.errors).not.toHaveBeenCalled();
      expect(test.shutdown).not.toHaveBeenCalled();
    },
  );

  it("finishes corrective follow-ups before replacing the session", async () => {
    let checks = 0;
    const stopHook: ExtensionFactory = (pi) => {
      pi.on("agent_settled", () => {
        checks += 1;
        if (checks > 2) return;
        pi.sendUserMessage("Stop checks failed: correct PLAN.md.");
      });
    };
    const test = await start([stopHook, contextHandoff], "tui");
    test.faux.setResponses([
      fauxAssistantMessage("work"),
      writePlan("initial"),
      fauxAssistantMessage("saved"),
      writePlan("first correction"),
      fauxAssistantMessage("corrected"),
      writePlan("final correction"),
      fauxAssistantMessage("corrected again"),
      async () => {
        const planPath = join(test.directory, "PLAN.md");
        await expectFile(planPath, "final correction");
        vi.spyOn(test.runtime.session, "getContextUsage").mockReturnValue(
          undefined,
        );
        return fauxAssistantMessage("continued");
      },
    ]);
    await test.runtime.session.prompt("work");
    expect(test.sessions).toHaveLength(2);
    expect(test.errors).not.toHaveBeenCalled();
    expect(test.shutdown).not.toHaveBeenCalled();
  });

  it.each<"error" | "aborted">(["error", "aborted"])(
    "does not replace after a corrective follow-up ends with %s",
    async (stopReason) => {
      let checks = 0;
      const stopHook: ExtensionFactory = (pi) => {
        pi.on("agent_settled", () => {
          checks += 1;
          if (checks !== 1) return;
          pi.sendUserMessage("Correct the plan before continuing.");
        });
      };
      const test = await start([stopHook, contextHandoff], "tui");
      const original = test.runtime.session;
      test.faux.setResponses([
        fauxAssistantMessage("work"),
        writePlan("saved"),
        fauxAssistantMessage("saved"),
        fauxAssistantMessage("failed correction", {
          stopReason,
          errorMessage: "scripted failure",
        }),
      ]);
      await original.prompt("work");
      expect(test.sessions).toHaveLength(1);
      expect(test.runtime.session).toBe(original);
      expect(test.errors).not.toHaveBeenCalled();
      expect(test.shutdown).not.toHaveBeenCalled();
      expectNoContinuation(original);
    },
  );

  it("reports replacement creation failure without using the invalidated context", async () => {
    const test = await start([contextHandoff], "rpc");
    const original = test.runtime.session;
    const log = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => undefined);
    const failure = new Error("scripted creation failure");
    test.factory.mockRejectedValueOnce(failure);
    test.faux.setResponses([
      fauxAssistantMessage("work"),
      writePlan("saved"),
      fauxAssistantMessage("saved"),
    ]);
    try {
      await original.prompt("work");
      expect(test.sessions).toHaveLength(1);
      expect(test.errors).toHaveBeenCalledOnce();
      const reportedError: unknown = expect.objectContaining({
        event: "command",
        error: "scripted creation failure",
      });
      expect(test.errors).toHaveBeenCalledWith(reportedError);
      expect(log).toHaveBeenCalledOnce();
      expectNoContinuation(original);
      expect(test.shutdown).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("surfaces replacement cancellation without prompting the old session", async () => {
    const cancel: ExtensionFactory = (pi) => {
      pi.on("session_before_switch", () => ({ cancel: true }));
    };
    const test = await start([contextHandoff, cancel], "tui");
    test.faux.setResponses([
      fauxAssistantMessage("work"),
      writePlan("saved"),
      fauxAssistantMessage("saved"),
    ]);
    const original = test.runtime.session;
    await original.prompt("work");
    expect(test.runtime.session).toBe(original);
    expect(test.sessions).toHaveLength(1);
    expect(test.notify).toHaveBeenCalledWith(
      "Context handoff session replacement cancelled",
      "warning",
    );
    expectNoContinuation(original);
    expect(test.errors).not.toHaveBeenCalled();
    expect(test.shutdown).not.toHaveBeenCalled();
  });
});
