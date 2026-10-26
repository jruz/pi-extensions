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
import type { OAuthCredential } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexAccountSwap from "../extensions/codex-account-swap.ts";
import { swapCredentials } from "../extensions/codex-account-swap/storage.ts";
import { logError } from "../extensions/shared/log.ts";

vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const actual =
    await original<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: vi.fn() };
});

vi.mock("../extensions/shared/log.ts", () => ({
  logError: vi.fn(() => Promise.resolve()),
}));

const log = vi.mocked(logError);
const cleanups: (() => Promise<void>)[] = [];
const credential = (account: string): OAuthCredential => ({
  type: "oauth",
  access: `synthetic-${account}`,
  refresh: `synthetic-refresh-${account}`,
  expires: Date.now() + 3_600_000,
  accountId: account,
});

const readAuth = async (path: string): Promise<unknown> => {
  try {
    const content = await readFile(path, "utf8");
    const value: unknown = JSON.parse(content);
    return value;
  } catch (error) {
    process.emitWarning("test credential read failed");
    throw error;
  }
};

const setup = async (
  names: readonly [string, string] = ["account-1", "account-2"],
) => {
  const root = tmpdir();
  const prefix = join(root, "pi-codex-swap-");
  const directory = await mkdtemp(prefix);
  const agentDir = vi.mocked(getAgentDir);
  agentDir.mockReturnValue(directory);
  const authPath = join(directory, "auth.json");
  const firstAccount = credential("account-1-id");
  const secondAccount = credential("account-2-id");
  const current = {
    ...firstAccount,
    refresh: "synthetic-rotated-account-1-refresh",
  };
  const unrelated = { type: "api_key", key: "synthetic-other-provider" };
  const accounts = { [names[0]]: firstAccount, [names[1]]: secondAccount };
  const initial = {
    "codex-account-swap": accounts,
    "openai-codex": current,
    unrelated,
  };
  const content = JSON.stringify(initial);
  await writeFile(authPath, content, { mode: 0o600 });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "openai-codex",
    defaultThinkingLevel: "high",
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
    extensionFactories: [codexAccountSwap],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    modelsStorePath: join(directory, "models-cache.json"),
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModels("openai-codex")[0];
  if (model === undefined) throw new Error("test model unavailable: Codex");
  const sessionManager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model,
    resourceLoader,
    settingsManager,
    sessionManager,
    tools: [],
  });
  const errors = vi.fn();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const ui = session.extensionRunner.getUIContext();
  await session.bindExtensions({
    onError: errors,
    uiContext: { ...ui, notify, setStatus },
  });
  cleanups.push(async () => {
    session.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    session,
    modelRuntime,
    settingsManager,
    directory,
    authPath,
    initial,
    firstAccount,
    secondAccount,
    errors,
    notify,
    setStatus,
  };
};

afterEach(async () => {
  const pending = cleanups.splice(0);
  const actions = pending.map((cleanup) => cleanup());
  await Promise.all(actions);
  vi.clearAllMocks();
});

describe("Codex account swap", () => {
  it("toggles credentials without changing the model, conversation, thinking or default", async () => {
    const runtime = await setup();
    const model = runtime.session.model;
    const sessionId = runtime.session.sessionManager.getSessionId();
    const thinking = runtime.session.thinkingLevel;
    await runtime.session.prompt("/codex-account-swap");
    const auth = await readAuth(runtime.authPath);
    expect(auth).toEqual({
      ...runtime.initial,
      "codex-account-swap": {
        "account-1": runtime.initial["openai-codex"],
        "account-2": runtime.secondAccount,
      },
      "openai-codex": runtime.secondAccount,
    });
    expect(runtime.session.model).toEqual(model);
    expect(runtime.session.thinkingLevel).toBe(thinking);
    const currentSessionId = runtime.session.sessionManager.getSessionId();
    const defaultProvider = runtime.settingsManager.getDefaultProvider();
    expect(currentSessionId).toBe(sessionId);
    expect(defaultProvider).toBe("openai-codex");
    expect(runtime.setStatus).toHaveBeenLastCalledWith(
      "codex-account-swap",
      "account-2",
    );
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("uses the swapped credentials on the next request without a reload", async () => {
    const runtime = await setup();
    const before = await runtime.modelRuntime.getAuth("openai-codex");
    expect(before).toMatchObject({
      auth: { apiKey: "synthetic-account-1-id" },
    });
    await runtime.session.prompt("/codex-account-swap account-2");
    const after = await runtime.modelRuntime.getAuth("openai-codex");
    expect(after).toMatchObject({ auth: { apiKey: "synthetic-account-2-id" } });
    const providers = runtime.modelRuntime.getProviders();
    const alias = providers.find(
      (provider) => provider.id === "openai-codex-2",
    );
    expect(alias).toBeUndefined();
    expect(runtime.errors).not.toHaveBeenCalled();
  });

  it("saves rotated credentials for both accounts before switching back", async () => {
    const runtime = await setup();
    await runtime.session.prompt("/codex-account-swap account-2");
    const updatedSecondAccount = {
      ...runtime.secondAccount,
      refresh: "synthetic-rotated-account-2-refresh",
    };
    const updated = {
      ...runtime.initial,
      "codex-account-swap": {
        "account-1": runtime.initial["openai-codex"],
        "account-2": runtime.secondAccount,
      },
      "openai-codex": updatedSecondAccount,
    };
    const content = JSON.stringify(updated);
    await writeFile(runtime.authPath, content);
    await runtime.session.prompt("/codex-account-swap account-1");
    const auth = await readAuth(runtime.authPath);
    expect(auth).toEqual({
      ...updated,
      "codex-account-swap": {
        "account-1": runtime.initial["openai-codex"],
        "account-2": updatedSecondAccount,
      },
      "openai-codex": runtime.initial["openai-codex"],
    });
  });

  it("does not restore stale credentials when selecting the already active account", async () => {
    const runtime = await setup();
    await runtime.session.prompt("/codex-account-swap account-1");
    const auth = await readAuth(runtime.authPath);
    expect(auth).toEqual({
      ...runtime.initial,
      "codex-account-swap": {
        "account-1": runtime.initial["openai-codex"],
        "account-2": runtime.secondAccount,
      },
    });
  });

  it("shows the active account on startup", async () => {
    const runtime = await setup();
    expect(runtime.setStatus).toHaveBeenCalledWith(
      "codex-account-swap",
      "account-1",
    );
  });

  it("rejects invalid arguments without writing credentials", async () => {
    const runtime = await setup();
    await runtime.session.prompt("/codex-account-swap other");
    const auth = await readAuth(runtime.authPath);
    expect(auth).toEqual(runtime.initial);
    expect(runtime.notify).toHaveBeenCalledWith(
      "account swap: unknown account other",
      "error",
    );
    expect(log).toHaveBeenCalledOnce();
  });

  it("refuses to change credentials while Pi holds the auth lock", async () => {
    const runtime = await setup();
    const lockPath = `${runtime.authPath}.lock`;
    await mkdir(lockPath);
    await runtime.session.prompt("/codex-account-swap");
    const auth = await readAuth(runtime.authPath);
    expect(auth).toEqual(runtime.initial);
    expect(runtime.notify).toHaveBeenCalledWith(
      "account credentials: auth.json is busy; retry shortly",
      "error",
    );
  });

  it("fails clearly when a named credential is missing", async () => {
    const runtime = await setup();
    const incomplete = {
      "openai-codex": runtime.firstAccount,
      "codex-account-swap": { "account-1": runtime.firstAccount },
    };
    const content = JSON.stringify(incomplete);
    await writeFile(runtime.authPath, content);
    const swap = swapCredentials(runtime.authPath, "account-2");
    await expect(swap).rejects.toThrow(
      "account credentials: codex-account-swap must contain two named OAuth entries",
    );
    const auth = await readAuth(runtime.authPath);
    expect(auth).toEqual(incomplete);
  });

  it("accepts configured names instead of requiring example names", async () => {
    const runtime = await setup(["personal", "work"]);
    expect(runtime.setStatus).toHaveBeenCalledWith(
      "codex-account-swap",
      "personal",
    );
    await runtime.session.prompt("/codex-account-swap work");
    expect(runtime.setStatus).toHaveBeenLastCalledWith(
      "codex-account-swap",
      "work",
    );
    const auth = await readAuth(runtime.authPath);
    expect(auth).toEqual({
      ...runtime.initial,
      "codex-account-swap": {
        personal: runtime.initial["openai-codex"],
        work: runtime.secondAccount,
      },
      "openai-codex": runtime.secondAccount,
    });
  });

  it("logs account read failures with project context and exposes an error status", async () => {
    const runtime = await setup();
    const invalid = JSON.stringify({
      ...runtime.initial,
      "codex-account-swap": {},
    });
    await writeFile(runtime.authPath, invalid);
    await runtime.session.extensionRunner.emit({
      type: "session_start",
      reason: "startup",
    });
    expect(runtime.setStatus).toHaveBeenLastCalledWith(
      "codex-account-swap",
      "err",
    );
    const logged = log.mock.calls.at(-1);
    expect(logged?.[0]).toBe("codex-account-swap");
    expect(logged?.[1]).toBeInstanceOf(Error);
    expect(logged?.[2]).toEqual({ cwd: runtime.directory, operation: "read" });
  });

  it("keeps credentials private after an atomic swap", async () => {
    const runtime = await setup();
    await runtime.session.prompt("/codex-account-swap");
    const info = await stat(runtime.authPath);
    const permissions = info.mode & 0o777;
    expect(permissions).toBe(0o600);
  });
});
