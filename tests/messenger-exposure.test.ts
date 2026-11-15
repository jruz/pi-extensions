import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import chatPreview from "../extensions/chat-preview.ts";
import messenger from "../extensions/messenger/index.ts";
import type { AgentRecord } from "../extensions/messenger/protocol.ts";
import {
  createRuntime,
  type MessengerRuntime,
} from "../extensions/messenger/runtime.ts";
import { createTransport } from "../extensions/messenger/transport.ts";

const home = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = os.tmpdir();
  const prefix = path.join(root, "pi-exposure-home-");
  return fs.mkdtemp(prefix);
});

const sends = vi.hoisted(() => {
  const calls: unknown[] = [];
  return { calls };
});

vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: () => home };
});

vi.mock("../extensions/messenger/runtime.ts", async (original) => {
  const actual =
    await original<typeof import("../extensions/messenger/runtime.ts")>();
  const createRuntime = (
    options: Parameters<typeof actual.createRuntime>[0],
  ): MessengerRuntime => {
    const runtime = actual.createRuntime(options);
    const send: MessengerRuntime["send"] = (...args) => {
      sends.calls.push(args);
      return runtime.send(...args);
    };
    return { ...runtime, send };
  };
  return { ...actual, createRuntime };
});

type Probe = Readonly<{ callable: readonly string[]; nested: string }>;
type Args = ToolCall["arguments"];

const createProbe =
  (target: string, args: Args, probes: Probe[]): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    pi.registerTool({
      description: "Call another tool the way codemode scripts do.",
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const callable = ctx.tools.map((tool) => tool.name);
        const outcome = await ctx.executeTool(target, args);
        const nested = outcome.result.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        probes.push({ callable, nested });
        return { content: [{ text: nested, type: "text" }], details: {} };
      },
      label: "Probe",
      name: "probe",
      parameters: Type.Object({}),
    });
  };

const cleanups: (() => Promise<void>)[] = [];

const start = async (extensionFactories: ExtensionFactory[]) => {
  const projects = join(home, "dev/projects");
  await mkdir(projects, { recursive: true });
  const prefix = join(projects, "exposure-");
  const directory = await mkdtemp(prefix);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resources = new DefaultResourceLoader({
    agentDir: directory,
    cwd: directory,
    extensionFactories,
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });
  await resources.reload();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models-cache.json"),
    refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: "exposure-test" }] });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    agentDir: directory,
    cwd: directory,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader: resources,
    sessionManager: SessionManager.inMemory(directory),
    settingsManager,
  });
  const runner = session.extensionRunner;
  const errors = vi.fn<(error: ExtensionError) => void>();
  await session.bindExtensions({
    mode: "tui",
    onError: errors,
    uiContext: runner.getUIContext(),
  });
  cleanups.push(async () => {
    await runner.emit({ reason: "quit", type: "session_shutdown" });
    session.dispose();
    await rm(directory, { force: true, recursive: true });
  });
  return { errors, faux, session };
};

const toolResults = (session: AgentSession, name: string) =>
  session.messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === name ? [message] : [],
  );

const callTool = (name: string, args: Args) => {
  const call = fauxToolCall(name, args);
  return fauxAssistantMessage(call);
};

const run = async (
  extension: ExtensionFactory,
  target: string,
  nested: Args,
  direct: Args,
) => {
  const probes: Probe[] = [];
  const probe = createProbe(target, nested, probes);
  const { session, faux, errors } = await start([extension, probe]);
  faux.setResponses([
    callTool("probe", {}),
    callTool(target, direct),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("probe exposure");
  const results = toolResults(session, target);
  return { errors, probes, results, session };
};

const startPeer = async () => {
  const delivered: string[] = [];
  const directory = join(home, ".pi/agent/messenger/v3");
  const agent: AgentRecord = {
    id: randomUUID(),
    instanceId: randomUUID(),
    projectPath: join(home, "dev/projects/peer"),
    status: "busy",
  };
  const transport = createTransport(directory, (error) => {
    throw error;
  });
  const runtime = createRuntime({
    agent,
    deliver: (text) => {
      delivered.push(text);
    },
    isIdle: () => true,
    transport,
  });
  await runtime.start();
  cleanups.push(runtime.stop);
  return { agent, delivered, runtime };
};

afterEach(async () => {
  const pending = cleanups.splice(0);
  const actions = pending.map((cleanup) => cleanup());
  await Promise.all(actions);
  sends.calls.splice(0);
});

afterAll(async () => {
  await rm(home, { force: true, recursive: true });
});

describe("tool exposure", () => {
  it.each([
    { args: { action: "me" }, extension: messenger, name: "messenger" },
    {
      args: { state: "running" },
      extension: chatPreview,
      name: "chat_preview",
    },
  ])(
    "declares $name to the model but keeps it out of nested calls",
    async ({ name, extension, args }) => {
      const runtime = await run(extension, name, args, args);
      const active = runtime.session.getActiveToolNames();
      expect(active).toContain(name);
      expect(runtime.probes[0]?.callable).not.toContain(name);
      expect(runtime.probes[0]?.nested).toMatch(/not found/i);
      expect(runtime.results).toMatchObject([{ isError: false }]);
      expect(runtime.errors).not.toHaveBeenCalled();
    },
  );

  it("rejects nested messenger sends before the runtime sees them", async () => {
    const send = { action: "send", message: "hi", to: randomUUID() };
    const runtime = await run(messenger, "messenger", send, { action: "me" });
    expect(runtime.probes[0]?.nested).toMatch(/not found/i);
    expect(sends.calls).toEqual([]);
  });

  it("sends the reviewed retry once a direct withheld batch reaches model context", async () => {
    const peer = await startPeer();
    const { session, faux, errors } = await start([messenger]);
    const sessionId = session.sessionManager.getSessionId();
    const draft = (message: string) =>
      callTool("messenger", { action: "send", message, to: peer.agent.id });
    faux.setResponses([
      async () => {
        await peer.runtime.send(
          sessionId,
          "use the fast path",
          "normal",
          undefined,
        );
        return draft("first draft");
      },
      draft("reviewed draft"),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("reply to the peer");
    const [withheld, sent] = toolResults(session, "messenger");
    const withheldText = withheld?.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    expect(withheldText).toContain("Message NOT sent.");
    expect(withheldText).toContain("use the fast path");
    expect(sent).toMatchObject({ isError: false });
    await peer.runtime.poll();
    expect(peer.delivered).toHaveLength(1);
    expect(peer.delivered[0]).toContain("reviewed draft");
    expect(peer.delivered[0]).not.toContain("first draft");
    expect(errors).not.toHaveBeenCalled();
  });
});
