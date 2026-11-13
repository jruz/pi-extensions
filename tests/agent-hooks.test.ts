import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionError,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import agentHooks from "../extensions/agent-hooks.ts";

const hooks = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = os.tmpdir();
  const prefix = path.join(root, "pi-hook-fixture-");
  return fs.mkdtemp(prefix);
});

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: vi.fn<(path: string) => string>((path) =>
      path.endsWith("agent-config-hooks") ? hooks : actual.realpathSync(path),
    ),
  };
});

vi.mock("../extensions/shared/log-path.ts", () => ({
  PI_LOG_DIRECTORY: hooks,
}));

const cleanups: (() => Promise<void>)[] = [];

const setup = async (script: string) => {
  const stopPath = join(hooks, "on_stop");
  await writeFile(stopPath, `#!/bin/sh\n${script}\n`, {
    mode: 0o700,
  });
  const root = tmpdir();
  const prefix = join(root, "pi-hook-session-");
  const directory = await mkdtemp(prefix);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resources = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [agentHooks],
  });
  await resources.reload();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models-cache.json"),
    refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: "hook-test" }] });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: resources,
    settingsManager,
    sessionManager: SessionManager.inMemory(directory),
    tools: [],
  });
  const runner = session.extensionRunner;
  initTheme("dark", false);
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const errors = vi.fn<(error: ExtensionError) => void>();
  await session.bindExtensions({
    uiContext: { ...runner.getUIContext(), notify },
    onError: errors,
  });
  const sendUserMessage = vi.spyOn(session, "sendUserMessage");
  const sendMessage = vi.spyOn(session, "sendCustomMessage");
  cleanups.push(async () => {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { runner, notify, errors, sendUserMessage, sendMessage };
};

afterEach(async () => {
  const pending = cleanups.splice(0).map((cleanup) => cleanup());
  await Promise.all(pending);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(hooks, { recursive: true, force: true });
});

it("runs the argument-free stop hook without requesting another model turn", async () => {
  const runtime = await setup('test "$#" -eq 0');
  await runtime.runner.emit({ type: "agent_settled", aborted: false });
  expect(runtime.errors).not.toHaveBeenCalled();
  expect(runtime.notify).not.toHaveBeenCalled();
  expect(runtime.sendUserMessage).not.toHaveBeenCalled();
  expect(runtime.sendMessage).not.toHaveBeenCalled();
});

it.each([
  ["exit 1", "infrastructure failure", "error"],
  ["printf 'invalid json'", "protocol failure", "error"],
  [
    `printf '%s' '{"decision":"block","reason":"checks failed"}'`,
    "checks failed",
    "warning",
  ],
])(
  "reports stop failure without model work: %s",
  async (script, message, level) => {
    const runtime = await setup(script);
    await runtime.runner.emit({ type: "agent_settled", aborted: false });
    await runtime.runner.emit({ type: "agent_settled", aborted: false });
    expect(runtime.errors).not.toHaveBeenCalled();
    const expectedMessage: unknown = expect.stringContaining(message);
    expect(runtime.notify).toHaveBeenCalledWith(expectedMessage, level);
    expect(runtime.sendUserMessage).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  },
);

it("preserves subprocess diagnostics in the hook log", async () => {
  const runtime = await setup("printf 'synthetic stop diagnostic' >&2; exit 1");
  await runtime.runner.emit({ type: "agent_settled", aborted: false });
  const logPath = join(hooks, "pi-agent-hooks.log");
  const log = await readFile(logPath, "utf8");
  expect(log).toContain("synthetic stop diagnostic");
  expect(log).toContain("exit_status=1");
});

it("reports a stop timeout without requesting another model turn", async () => {
  const runtime = await setup("exec sleep 60");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const settled = runtime.runner.emit({
      type: "agent_settled",
      aborted: false,
    });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await settled;
    const message: unknown = expect.stringContaining("hook timed out");
    expect(runtime.notify).toHaveBeenCalledWith(message, "error");
    expect(runtime.sendUserMessage).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(runtime.errors).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("does not run a stop hook after cancellation", async () => {
  const runtime = await setup("exit 1");
  await runtime.runner.emit({ type: "agent_settled", aborted: true });
  expect(runtime.notify).not.toHaveBeenCalled();
  expect(runtime.errors).not.toHaveBeenCalled();
  expect(runtime.sendUserMessage).not.toHaveBeenCalled();
});
