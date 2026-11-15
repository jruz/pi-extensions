import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ExtensionError,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  ProcessTerminal,
  TuiMainScreen,
  type Component,
} from "@earendil-works/pi-tui";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import statusLine from "../extensions/status-line.ts";
import { PI_LOG_DIRECTORY } from "../extensions/shared/log-path.ts";

const home = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = os.tmpdir();
  const prefix = path.join(root, "pi-footer-home-");
  return fs.mkdtemp(prefix);
});

vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: () => home };
});

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn<typeof actual.stat>(actual.stat) };
});

const usageLockPath = join(
  home,
  ".cache/pi/statusline-codex-usage-cache.json.lock",
);

type ExtensionMode = ExtensionContext["mode"];
type Footer = Component & Readonly<{ dispose?: () => void }>;
const cleanups: (() => Promise<void>)[] = [];
const fetchMock = vi.fn<typeof fetch>();
const usageResponse = () => Response.json({ rate_limit: null });

const setup = async () => {
  const root = tmpdir();
  const prefix = join(root, "pi-footer-session-");
  const directory = await mkdtemp(prefix);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const events = createEventBus();
  const resources = new DefaultResourceLoader({
    agentDir: directory,
    cwd: directory,
    eventBus: events,
    extensionFactories: [statusLine],
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
  const faux = fauxProvider({
    models: [{ id: "footer-test", reasoning: true }],
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    agentDir: directory,
    cwd: directory,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader: resources,
    sessionManager: SessionManager.inMemory(directory),
    settingsManager,
    tools: [],
  });
  const runner = session.extensionRunner;
  const registry = runner.getModelRegistry();
  const auth = vi.spyOn(registry, "getProviderAuth");
  auth.mockResolvedValue({ auth: { apiKey: "synthetic-test-token" } });
  initTheme("dark", false);
  const ui = runner.getUIContext();
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const requestRender = vi
    .spyOn(tui, "requestRender")
    .mockImplementation(() => undefined);
  const unsubscribe = vi.fn<() => void>();
  const footers: Footer[] = [];
  const statuses = new Map<string, string>();
  const setFooter = vi.fn<ExtensionUIContext["setFooter"]>((factory) => {
    if (factory === undefined) return;
    const footer = factory(tui, ui.theme, {
      getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => statuses,
      getGitBranch: () => null,
      onBranchChange: () => unsubscribe,
    });
    footers.push(footer);
  });
  const errors = vi.fn<(error: ExtensionError) => void>();
  const start = async (mode: ExtensionMode) => {
    await session.bindExtensions({
      mode,
      onError: errors,
      uiContext: { ...ui, setFooter },
    });
  };
  const stop = () => runner.emit({ reason: "quit", type: "session_shutdown" });
  cleanups.push(async () => {
    await stop();
    footers.forEach((footer) => footer.dispose?.());
    session.dispose();
    await rm(directory, { force: true, recursive: true });
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => {
    const response = usageResponse();
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  return {
    auth,
    errors,
    events,
    footers,
    requestRender,
    runner,
    session,
    setFooter,
    start,
    statuses,
    stop,
    theme: ui.theme,
    unsubscribe,
  };
};

afterEach(async () => {
  const pending = cleanups.splice(0);
  const actions = pending.map((cleanup) => cleanup());
  await Promise.all(actions);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { force: true, recursive: true });
});

afterAll(async () => {
  await rm(home, { force: true, recursive: true });
});

const renderFooter = (footers: Footer[]): string => {
  const footer = footers.at(-1);
  if (footer === undefined) throw new Error("test: no footer");
  const lines = footer.render(120);
  return lines.join("\n");
};

describe("status line lifecycle", () => {
  it.each<ExtensionMode>(["rpc", "print"])(
    "does no footer work in %s mode",
    async (mode) => {
      const runtime = await setup();
      await runtime.start(mode);
      await vi.advanceTimersByTimeAsync(600000);
      expect(runtime.setFooter).not.toHaveBeenCalled();
      expect(runtime.auth).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(runtime.errors).not.toHaveBeenCalled();
    },
  );

  it("cleans refresh timers on shutdown and prevents stale callbacks from restarting work", async () => {
    const runtime = await setup();
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      const timers = vi.getTimerCount();
      expect(timers).toBe(1);
    });
    await runtime.stop();
    expect(runtime.unsubscribe).toHaveBeenCalledOnce();
    const timersAfterShutdown = vi.getTimerCount();
    expect(timersAfterShutdown).toBe(0);
    const renders = runtime.requestRender.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(runtime.requestRender).toHaveBeenCalledTimes(renders);
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("aborts a pending fetch without rescheduling or rendering after shutdown", async () => {
    const runtime = await setup();
    let requestSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url, options) => {
      requestSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => {
            reject(new Error("test: cancelled"));
          },
          { once: true },
        );
      });
    });
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    await runtime.stop();
    expect(requestSignal?.aborted).toBe(true);
    const renders = runtime.requestRender.mock.calls.length;
    await vi.waitFor(() => {
      const timers = vi.getTimerCount();
      expect(timers).toBe(0);
    });
    await vi.advanceTimersByTimeAsync(600000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(runtime.requestRender).toHaveBeenCalledTimes(renders);
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("does not let old authentication completion fetch or render into a replacement session", async () => {
    const runtime = await setup();
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof runtime.auth>>>();
    runtime.auth.mockReturnValueOnce(pending.promise);
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(runtime.auth).toHaveBeenCalledOnce();
    });
    await runtime.start("rpc");
    const renders = runtime.requestRender.mock.calls.length;
    pending.resolve({ auth: { apiKey: "synthetic-old-token" } });
    await vi.advanceTimersByTimeAsync(600000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.requestRender).toHaveBeenCalledTimes(renders);
    const timersAfterReplacement = vi.getTimerCount();
    expect(timersAfterReplacement).toBe(0);
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("uses only companion authentication while leaving the active model unchanged", async () => {
    const runtime = await setup();
    runtime.auth.mockResolvedValue({
      auth: {
        apiKey: "synthetic-api-key",
        headers: { "ChatGPT-Account-Id": "synthetic-account" },
      },
    });
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    const request = fetchMock.mock.calls[0];
    if (request === undefined) throw new Error("test: no request");
    const headers = new Headers(request[1]?.headers);
    const authorization = headers.get("Authorization");
    const account = headers.get("ChatGPT-Account-Id");
    expect(authorization).toBe("Bearer synthetic-api-key");
    expect(account).toBe("synthetic-account");
    expect(runtime.auth).toHaveBeenCalledExactlyOnceWith("openai-codex");
    expect(runtime.session.model?.provider).toBe("faux");
  });

  it("invalidates cached quota and shows the selected account after a credential swap", async () => {
    const runtime = await setup();
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
      const timers = vi.getTimerCount();
      expect(timers).toBe(1);
    });
    runtime.statuses.set("codex-account-swap", "account-2");
    runtime.auth.mockResolvedValue({
      auth: { apiKey: "synthetic-account-2-token" },
    });
    runtime.events.emit("codex-account-swap:changed", { account: "account-2" });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const timers = vi.getTimerCount();
      expect(timers).toBe(1);
    });
    expect(runtime.auth).toHaveBeenLastCalledWith("openai-codex");
    const footer = renderFooter(runtime.footers);
    const lines = footer.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("Process:");
    expect(lines[2]).not.toContain("Account:");
    expect(lines[3]).toContain("Account:");
    expect(lines[3]).toContain("account-2");
    const request = fetchMock.mock.calls[1];
    if (request === undefined) throw new Error("test: no swapped request");
    const headers = new Headers(request[1]?.headers);
    const authorization = headers.get("Authorization");
    expect(authorization).toBe("Bearer synthetic-account-2-token");
    const cachePath = join(home, ".cache/pi/statusline-codex-usage-cache.json");
    const cache = await readFile(cachePath, "utf8");
    expect(cache).toContain('"limits":{"fiveHour":{},"weekly":{}}');
    expect(runtime.unsubscribe).toHaveBeenCalledOnce();
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("renders account errors with the theme error color", async () => {
    const runtime = await setup();
    runtime.statuses.set("codex-account-swap", "err");
    await runtime.start("tui");
    const footer = renderFooter(runtime.footers);
    const accountLine = footer.split("\n").at(-1);
    const redError = runtime.theme.fg("error", "err");
    const normalError = runtime.theme.fg("text", "err");
    expect(accountLine).toContain("Account:");
    expect(accountLine).toContain(redError);
    expect(redError).not.toBe(normalError);
  });

  it("discards an old account's pending authentication after switching", async () => {
    const runtime = await setup();
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof runtime.auth>>>();
    runtime.auth.mockReturnValueOnce(pending.promise);
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(runtime.auth).toHaveBeenCalledOnce();
    });
    runtime.events.emit("codex-account-swap:changed", { account: "account-2" });
    pending.resolve({ auth: { apiKey: "synthetic-old-account" } });
    await vi.waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledOnce();
        const timers = vi.getTimerCount();
        expect(timers).toBe(1);
      },
      { timeout: 2000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(runtime.auth).toHaveBeenLastCalledWith("openai-codex");
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("uses header-only authentication without inventing an API key", async () => {
    const runtime = await setup();
    runtime.auth.mockResolvedValue({
      auth: { headers: { Authorization: "Bearer synthetic-header" } },
    });
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    const request = fetchMock.mock.calls[0];
    if (request === undefined) throw new Error("test: no request");
    const headers = new Headers(request[1]?.headers);
    const authorization = headers.get("Authorization");
    expect(authorization).toBe("Bearer synthetic-header");
  });

  it("shows unavailable authentication without looking up another provider", async () => {
    const runtime = await setup();
    runtime.auth.mockResolvedValue(undefined);
    await runtime.start("tui");
    await vi.waitFor(() => {
      const footer = renderFooter(runtime.footers);
      expect(footer).toContain("err");
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.auth).toHaveBeenCalledOnce();
    expect(runtime.auth).toHaveBeenCalledWith("openai-codex");
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("honors resolved header overrides over the companion API key", async () => {
    const runtime = await setup();
    runtime.auth.mockResolvedValue({
      auth: {
        apiKey: "synthetic-key",
        headers: { Authorization: "Bearer synthetic-override" },
      },
    });
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    const request = fetchMock.mock.calls[0];
    if (request === undefined) throw new Error("test: no request");
    const headers = new Headers(request[1]?.headers);
    const authorization = headers.get("Authorization");
    expect(authorization).toBe("Bearer synthetic-override");
  });

  it("shows refresh failure instead of stale cached usage and recovers on retry", async () => {
    const runtime = await setup();
    const cacheDirectory = join(home, ".cache/pi");
    await mkdir(cacheDirectory, { recursive: true });
    const cachePath = join(cacheDirectory, "statusline-codex-usage-cache.json");
    const cache = JSON.stringify({
      fetchedAt: Date.now() - 600000,
      limits: {
        fiveHour: { remainingPercent: 75, windowMinutes: 300 },
        weekly: { remainingPercent: 60, windowMinutes: 10080 },
      },
    });
    await writeFile(cachePath, cache);
    const failure = new Response(null, { status: 401 });
    fetchMock.mockResolvedValueOnce(failure);
    await runtime.start("tui");
    await vi.waitFor(() => {
      const footer = renderFooter(runtime.footers);
      expect(footer).toContain("err");
      expect(footer).not.toContain("75%");
    });
    await vi.advanceTimersByTimeAsync(59999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const footer = renderFooter(runtime.footers);
      expect(footer).not.toContain("err");
    });
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("recovers when another session removes the usage lock before stat", async () => {
    const runtime = await setup();
    await mkdir(usageLockPath, { recursive: true });
    const filesystem =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(stat).mockImplementationOnce(async () => {
      await rm(usageLockPath, { recursive: true });
      return filesystem.stat(usageLockPath);
    });
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
      const footer = renderFooter(runtime.footers);
      expect(footer).not.toContain("err");
      const timers = vi.getTimerCount();
      expect(timers).toBe(1);
    });
    expect(stat).toHaveBeenCalledExactlyOnceWith(usageLockPath);
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("waits for an existing usage lock and refreshes once it is released", async () => {
    const runtime = await setup();
    await mkdir(usageLockPath, { recursive: true });
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(stat).toHaveBeenCalledWith(usageLockPath);
      const timers = vi.getTimerCount();
      expect(timers).toBe(1);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await rm(usageLockPath, { recursive: true });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    const footer = renderFooter(runtime.footers);
    expect(footer).not.toContain("err");
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EIO"])(
    "surfaces unrelated usage-lock stat errors: %s",
    async (code) => {
      const runtime = await setup();
      await mkdir(usageLockPath, { recursive: true });
      const message = `test: lock stat failed: ${code}`;
      const failure = Object.assign(new Error(message), { code });
      vi.mocked(stat).mockRejectedValueOnce(failure);
      await runtime.start("tui");
      await vi.waitFor(() => {
        const footer = renderFooter(runtime.footers);
        expect(footer).toContain("err");
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const logPath = join(PI_LOG_DIRECTORY, "pi-status-line.log");
      const log = await readFile(logPath, "utf8");
      expect(log).toContain(message);
      expect(runtime.errors).not.toHaveBeenCalled();
    },
  );

  it("replaces a TUI session without old disposal stopping the new refresh timer", async () => {
    const runtime = await setup();
    await runtime.start("tui");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      const timers = vi.getTimerCount();
      expect(timers).toBe(1);
    });
    const oldFooter = runtime.footers[0];
    if (oldFooter === undefined) throw new Error("test: no old footer");
    await runtime.start("tui");
    oldFooter.dispose?.();
    await vi.waitFor(() => {
      const timers = vi.getTimerCount();
      expect(timers).toBe(1);
    });
    await runtime.stop();
    const timers = vi.getTimerCount();
    expect(timers).toBe(0);
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("renders thinking changes without a model change", async () => {
    const runtime = await setup();
    await runtime.start("tui");
    const before = runtime.requestRender.mock.calls.length;
    runtime.session.setThinkingLevel("low");
    await vi.waitFor(() => {
      expect(runtime.requestRender.mock.calls.length).toBeGreaterThan(before);
    });
    const footer = renderFooter(runtime.footers);
    expect(footer).toContain("low");
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("tracks nested calls separately and clears counts on completion and session cancellation", async () => {
    const runtime = await setup();
    await runtime.start("tui");
    await runtime.runner.emit({
      args: {},
      toolCallId: "parent",
      toolName: "codemode",
      type: "tool_execution_start",
    });
    await runtime.runner.emit({
      args: {},
      parentToolCallId: "parent",
      toolCallId: "parent/1",
      toolName: "read",
      type: "tool_execution_start",
    });
    const nested = renderFooter(runtime.footers);
    expect(nested).toMatch(/Process:.*2/);
    await runtime.runner.emit({
      isError: false,
      parentToolCallId: "parent",
      result: {},
      toolCallId: "parent/1",
      toolName: "read",
      type: "tool_execution_end",
    });
    await runtime.runner.emit({
      isError: true,
      result: {},
      toolCallId: "parent",
      toolName: "codemode",
      type: "tool_execution_end",
    });
    const finished = renderFooter(runtime.footers);
    expect(finished).toMatch(/Process:.*0/);
    await runtime.runner.emit({
      args: {},
      toolCallId: "cancelled",
      toolName: "codemode",
      type: "tool_execution_start",
    });
    await runtime.runner.emit({ aborted: true, type: "agent_settled" });
    const cancelled = renderFooter(runtime.footers);
    expect(cancelled).toMatch(/Process:.*0/);
    await runtime.stop();
    await runtime.start("tui");
    const replaced = renderFooter(runtime.footers);
    expect(replaced).toMatch(/Process:.*0/);
    expect(runtime.errors).not.toHaveBeenCalled();
  });
});
