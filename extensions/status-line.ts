import type { Stats } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseColor, truncateToWidth } from "@earendil-works/pi-tui";
import { PI_LOG_DIRECTORY } from "./shared/log-path.ts";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_TTL_MS = 60 * 1000;
const USAGE_TIMEOUT_MS = 10 * 1000;
const USAGE_LOCK_TTL_MS = 30 * 1000;
const USAGE_LOCK_RETRY_MS = 1000;
const homeDirectory = homedir();
const USAGE_CACHE_PATH = resolve(
  homeDirectory,
  ".cache/pi/statusline-codex-usage-cache.json",
);
const PROGRESS_WIDTH = 10;
const LEFT_COLUMN_WIDTH = 35;
const CENTER_COLUMN_WIDTH = 22;
const OTHER_MODEL_COLOR = parseColor("#a855f7");

type RateWindow = Readonly<{
  remainingPercent: number | undefined;
  windowMinutes: number | undefined;
  resetsAt: number | undefined;
}>;

type UsageLimits = Readonly<{
  fiveHour: RateWindow;
  weekly: RateWindow;
}>;

type PlanProgress = Readonly<{
  completed: number;
  total: number;
}>;

type PlanState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "success"; value: PlanProgress }>
  | Readonly<{ status: "error"; message: string }>;

type UsageCache = Readonly<{
  fetchedAt: number;
  limits: UsageLimits;
}>;

type ModuleState<T> =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "success"; value: T }>
  | Readonly<{ status: "error"; message: string }>;

type FooterState = Readonly<{
  usage: ModuleState<UsageLimits>;
  plan: PlanState;
  activeTools: readonly string[];
}>;

const clampPercent = (percent: number): number => {
  const bounded = Math.min(100, percent);
  return Math.max(0, bounded);
};

export const renderProgressBar = (
  percent: number | undefined,
  width = PROGRESS_WIDTH,
): string => {
  if (percent === undefined) return "─".repeat(width);
  const clamped = clampPercent(percent);
  const filled = Math.ceil((clamped / 100) * width);
  return "━".repeat(filled) + "─".repeat(width - filled);
};

export const formatPercent = (percent: number | undefined): string => {
  if (percent === undefined) return "--";
  const clamped = clampPercent(percent);
  const rounded = Math.round(clamped);
  return `${rounded}%`;
};

export const formatTokens = (tokens: number): string => {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
};

export const parsePlanProgress = (content: string): PlanProgress => {
  const matches = content.match(/^\s*- \[[ xX]\]/gm);
  if (matches === null) return { completed: 0, total: 0 };
  const completed = matches.filter((match) => /\[[xX]\]/.test(match)).length;
  return { completed, total: matches.length };
};

const STATUS_LINE_LOG_PATH = resolve(PI_LOG_DIRECTORY, "pi-status-line.log");

const logStatusError = async (
  module: string,
  operation: string,
  error: unknown,
): Promise<void> => {
  const message = error instanceof Error ? error.message : "unknown error";
  const line = `timestamp=${new Date().toISOString()} module=${module} operation=${operation} error=${JSON.stringify(message)}\n`;
  await mkdir(PI_LOG_DIRECTORY, { recursive: true });
  await appendFile(STATUS_LINE_LOG_PATH, line);
};

const warnLoggingFailure = (loggingError: unknown): void => {
  const message =
    loggingError instanceof Error ? loggingError.message : "unknown error";
  process.emitWarning(
    `statusline error logging failed: ${message}`,
    "StatuslineError",
  );
};

const reportStatusError = (
  module: string,
  operation: string,
  error: unknown,
): Promise<void> =>
  logStatusError(module, operation, error).catch(warnLoggingFailure);

const reportUsageRefreshError = (error: unknown): Promise<void> =>
  reportStatusError("usage", "refresh", error);

const reportPlanReadError = (error: unknown): Promise<void> =>
  reportStatusError("plan", "read", error);

export const parseUsageCache = (value: unknown): UsageCache => {
  if (!isRecord(value)) throw new Error("usage cache is not an object");
  const fetchedAt = value["fetchedAt"];
  if (typeof fetchedAt !== "number")
    throw new Error("usage cache timestamp is invalid");
  const limits = value["limits"];
  if (!isRecord(limits)) throw new Error("usage cache limits are invalid");
  return {
    fetchedAt,
    limits: {
      fiveHour: readStoredWindow(limits["fiveHour"]),
      weekly: readStoredWindow(limits["weekly"]),
    },
  };
};

const readUsageCache = async (
  cachePath: string,
): Promise<UsageCache | undefined> => {
  try {
    const content = await readFile(cachePath, "utf8");
    const value: unknown = JSON.parse(content);
    const cache = parseUsageCache(value);
    return cache;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
};

const writeUsageCache = async (
  cachePath: string,
  limits: UsageLimits,
): Promise<void> => {
  const cacheDirectory = resolve(cachePath, "..");
  await mkdir(cacheDirectory, { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  const content = JSON.stringify({ fetchedAt: Date.now(), limits });
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, cachePath);
};

const releaseUsageLock = async (lockPath: string): Promise<void> => {
  await rm(lockPath, { recursive: true, force: true });
};

const acquireStaleUsageLock = async (lockPath: string): Promise<boolean> => {
  const staleLockPath = `${lockPath}.${process.pid}.stale`;
  try {
    await rename(lockPath, staleLockPath);
  } catch (renameError) {
    if (
      renameError instanceof Error &&
      "code" in renameError &&
      renameError.code === "ENOENT"
    )
      return acquireUsageLock(lockPath);
    throw renameError;
  }
  try {
    await mkdir(lockPath);
    return true;
  } catch (mkdirError) {
    await rm(staleLockPath, { recursive: true, force: true });
    if (
      mkdirError instanceof Error &&
      "code" in mkdirError &&
      mkdirError.code === "EEXIST"
    )
      return false;
    throw mkdirError;
  }
};

const readUsageLockStats = async (
  lockPath: string,
): Promise<Stats | undefined> => {
  try {
    return await stat(lockPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
};

const acquireUsageLock = async (lockPath: string): Promise<boolean> => {
  const cacheDirectory = resolve(lockPath, "..");
  await mkdir(cacheDirectory, { recursive: true });
  try {
    await mkdir(lockPath);
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    const lockStats = await readUsageLockStats(lockPath);
    if (lockStats === undefined) return acquireUsageLock(lockPath);
    if (Date.now() - lockStats.mtimeMs <= USAGE_LOCK_TTL_MS) return false;
    return acquireStaleUsageLock(lockPath);
  }
};

const readPlanProgress = async (cwd: string): Promise<PlanState> => {
  try {
    const planPath = resolve(cwd, "PLAN.md");
    const content = await readFile(planPath, "utf8");
    const progress = parsePlanProgress(content);
    return { status: "success", value: progress };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "missing" };
    }
    const message = error instanceof Error ? error.message : "unknown error";
    return { status: "error", message };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (typeof value !== "number")
    throw new Error(`usage field is not a number: ${key}`);
  return value;
};

const readOptionalNumber = (
  record: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== "number")
    throw new Error(`usage cache field is not a number: ${key}`);
  return value;
};

const readStoredWindow = (value: unknown): RateWindow => {
  if (!isRecord(value)) throw new Error("usage cache window is invalid");
  return {
    remainingPercent: readOptionalNumber(value, "remainingPercent"),
    windowMinutes: readOptionalNumber(value, "windowMinutes"),
    resetsAt: readOptionalNumber(value, "resetsAt"),
  };
};

const readWindow = (value: unknown): RateWindow => {
  if (value === null || value === undefined)
    return {
      remainingPercent: undefined,
      windowMinutes: undefined,
      resetsAt: undefined,
    };
  if (!isRecord(value)) throw new Error("usage window is not an object");
  const usedPercent = readNumber(value, "used_percent");
  const windowSeconds = readNumber(value, "limit_window_seconds");
  const resetsAt = readNumber(value, "reset_at");
  const windowMinutes = windowSeconds / 60;
  return {
    remainingPercent: 100 - usedPercent,
    windowMinutes,
    resetsAt,
  };
};

export const parseUsageLimits = (value: unknown): UsageLimits => {
  if (!isRecord(value)) throw new Error("usage response is not an object");
  const rateLimit = value["rate_limit"];
  if (rateLimit === null || rateLimit === undefined)
    return { fiveHour: readWindow(undefined), weekly: readWindow(undefined) };
  if (!isRecord(rateLimit))
    throw new Error("usage rate limit is not an object");
  const primaryWindow = readWindow(rateLimit["primary_window"]);
  const secondaryWindow = readWindow(rateLimit["secondary_window"]);
  return { fiveHour: primaryWindow, weekly: secondaryWindow };
};

export const formatDuration = (resetsAt: number, now = Date.now()): string => {
  const untilReset = (resetsAt * 1000 - now) / 60_000;
  const roundedMinutes = Math.ceil(untilReset);
  const minutes = Math.max(0, roundedMinutes);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes === 0
      ? `${hours}h`
      : `${hours}h ${remainingMinutes}m`;
  }
  const days = Math.floor(minutes / (24 * 60));
  const remainingHours = Math.floor((minutes % (24 * 60)) / 60);
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
};

type BarColor = "accent" | "dim" | "error" | "success" | "warning";
type ModelColor = "accent" | "warning" | "error" | "purple";

export const modelColor = (model: string): ModelColor => {
  if (model.endsWith("-terra")) return "accent";
  if (model.endsWith("-sol")) return "warning";
  if (model.endsWith("-astra")) return "error";
  return "purple";
};

const modelPrefix = /^gpt-[^-]+(?:-|$)/;

export const modelNameParts = (
  model: string,
): Readonly<{ prefix: string; suffix: string; color: ModelColor }> => {
  const match = modelPrefix.exec(model);
  if (match === null)
    return { prefix: model, suffix: "", color: modelColor(model) };
  const prefix = match[0];
  return {
    prefix,
    suffix: model.slice(prefix.length),
    color: modelColor(model),
  };
};

const renderModelName = (
  theme: Parameters<
    NonNullable<Parameters<NonNullable<ExtensionContext["ui"]["setFooter"]>>[0]>
  >[1],
  model: string,
): string => {
  const parts = modelNameParts(model);
  if (parts.suffix === "") return theme.fg("text", parts.prefix);
  const coloredPrefix = theme.fg("text", parts.prefix);
  const coloredSuffix =
    parts.color === "purple"
      ? theme.style(parts.suffix, { fg: OTHER_MODEL_COLOR })
      : theme.fg(parts.color, parts.suffix);
  return coloredPrefix + coloredSuffix;
};

export const contextBarColor = (percent: number | undefined): BarColor => {
  if (percent === undefined) return "dim";
  if (percent >= 70) return "error";
  if (percent >= 50) return "warning";
  return "success";
};

const usageBarColor = (percent: number | undefined): BarColor => {
  if (percent === undefined) return "dim";
  if (percent < 20) return "error";
  if (percent <= 40) return "warning";
  return "success";
};

export const renderColoredBar = (
  fg: (color: BarColor, text: string) => string,
  percent: number | undefined,
  color: BarColor,
): string => {
  const clamped = percent === undefined ? 0 : clampPercent(percent);
  const filled = Math.ceil((clamped / 100) * PROGRESS_WIDTH);
  const filledBar = "━".repeat(filled);
  const emptyBar = "─".repeat(PROGRESS_WIDTH - filled);
  return fg(color, filledBar) + fg("dim", emptyBar);
};

const coloredBar = (
  theme: Parameters<
    NonNullable<Parameters<NonNullable<ExtensionContext["ui"]["setFooter"]>>[0]>
  >[1],
  percent: number | undefined,
  color: BarColor,
): string =>
  renderColoredBar((name, text) => theme.fg(name, text), percent, color);

const renderColumn = (text: string, width: number): string =>
  truncateToWidth(text, width, "...", true);

type RuntimeColor = "muted" | "success" | "text" | "warning";

type RuntimeForeground = (color: RuntimeColor, text: string) => string;

export const formatDisplayPath = (cwd: string): string => {
  const directory = basename(cwd);
  const parentPath = resolve(cwd, "..");
  const parent = basename(parentPath);
  return `.../${parent}/${directory}`;
};

export const renderRuntimeLine = (
  fg: RuntimeForeground,
  cwd: string,
  processCount: number,
  hookStatus: string | undefined,
  width: number,
): string => {
  const processColor = processCount === 0 ? "text" : "warning";
  const processLabel = fg("muted", "Process:");
  const processValue = fg(processColor, `${processCount}`);
  const process = `${processLabel} ${processValue}`;
  const hooks = (() => {
    const hookLabel = fg("muted", "Hooks:");
    if (hookStatus === undefined || hookStatus === "") return hookLabel;
    const hookValue = fg("text", hookStatus);
    return `${hookLabel} ${hookValue}`;
  })();
  const pathLabel = fg("muted", "Path:");
  const displayPath = formatDisplayPath(cwd);
  const pathValue = fg("text", displayPath);
  const path = `${pathLabel} ${pathValue}`;
  const left = renderColumn(process, LEFT_COLUMN_WIDTH);
  const middle = renderColumn(hooks, CENTER_COLUMN_WIDTH);
  const rightWidth = Math.max(
    0,
    width - LEFT_COLUMN_WIDTH - CENTER_COLUMN_WIDTH,
  );
  const right = renderColumn(path, rightWidth);
  return truncateToWidth(`${left}${middle}${right}`, width);
};

const renderUsage = (
  theme: Parameters<
    NonNullable<Parameters<NonNullable<ExtensionContext["ui"]["setFooter"]>>[0]>
  >[1],
  label: string,
  state: ModuleState<UsageLimits>,
  window: RateWindow | undefined,
): string => {
  const percent = window?.remainingPercent;
  const details = (() => {
    if (state.status === "error") return theme.fg("error", "err");
    if (state.status !== "success" || !window) return theme.fg("text", "...");
    const resetsIn =
      window.resetsAt === undefined ? "--" : formatDuration(window.resetsAt);
    return `${formatPercent(percent).padStart(3)} (${resetsIn})`;
  })();
  const color = usageBarColor(percent);
  const bar = coloredBar(theme, percent, color);
  return `${theme.fg("muted", `${label}:`)} ${bar} ${details}`;
};

const renderFooter = (
  ctx: ExtensionContext,
  theme: Parameters<
    NonNullable<Parameters<NonNullable<ExtensionContext["ui"]["setFooter"]>>[0]>
  >[1],
  state: FooterState,
  width: number,
  reportError: (module: string, operation: string, error: unknown) => void,
  extensionStatuses: ReadonlyMap<string, string>,
): string[] => {
  const contextState: ModuleState<
    NonNullable<ReturnType<ExtensionContext["getContextUsage"]>>
  > = (() => {
    try {
      const usage = ctx.getContextUsage();
      return usage === undefined
        ? { status: "loading" }
        : { status: "success", value: usage };
    } catch (error) {
      reportError("context", "read", error);
      return {
        status: "error",
        message: error instanceof Error ? error.message : "unknown error",
      };
    }
  })();
  const modelState: ModuleState<string> = (() => {
    try {
      const modelId = ctx.model?.id;
      return modelId === undefined
        ? { status: "loading" }
        : { status: "success", value: modelId };
    } catch (error) {
      reportError("model", "read", error);
      return {
        status: "error",
        message: error instanceof Error ? error.message : "unknown error",
      };
    }
  })();
  const thinkingState: ModuleState<string> =
    ctx.thinkingLevel === undefined
      ? { status: "error", message: "thinking level unavailable" }
      : { status: "success", value: ctx.thinkingLevel };
  if (thinkingState.status === "error")
    reportError("thinking", "read", thinkingState.message);
  const plan = state.plan;
  const contextPercent =
    contextState.status === "success"
      ? (contextState.value.percent ?? undefined)
      : undefined;
  const contextDetails = (() => {
    if (contextState.status === "error") return theme.fg("error", "err");
    if (contextState.status === "loading") return theme.fg("text", "...");
    const { percent, tokens } = contextState.value;
    if (percent === null || tokens === null) return theme.fg("text", "...");
    return `${formatPercent(percent).padStart(3)} (${formatTokens(tokens)})`;
  })();
  const contextColor = contextBarColor(contextPercent);
  const contextBar = coloredBar(theme, contextPercent, contextColor);
  const context = `${theme.fg("muted", "Context:")} ${contextBar} ${contextDetails}`;
  const planPercent = (() => {
    if (plan.status !== "success") return undefined;
    if (plan.value.total === 0) return 100;
    return (plan.value.completed / plan.value.total) * 100;
  })();
  const planBar = coloredBar(theme, planPercent, "accent");
  const planValue = (() => {
    switch (plan.status) {
      case "success":
        return `${formatPercent(planPercent).padStart(3)} (${plan.value.completed}/${plan.value.total})`;
      case "missing":
        return theme.fg("text", "not-available");
      case "error":
        return theme.fg("error", "err");
      case "loading":
        return theme.fg("text", "...");
    }
  })();
  const planText = `${theme.fg("muted", "PLAN.md:")} ${planBar} ${planValue}`;
  const modelName = (() => {
    if (modelState.status === "error") return theme.fg("error", "err");
    if (modelState.status === "loading") return theme.fg("text", "...");
    return renderModelName(theme, modelState.value);
  })();
  const modelText = `${theme.fg("muted", "Model:")} ${modelName}`;
  const thinkingValue =
    thinkingState.status === "success"
      ? thinkingState.value
      : theme.fg("error", "err");
  const thinkingText = `${theme.fg("muted", "Thinking:")} ${thinkingValue}`;
  const fiveHour =
    state.usage.status === "success" ? state.usage.value.fiveHour : undefined;
  const weekly =
    state.usage.status === "success" ? state.usage.value.weekly : undefined;
  const left = renderColumn(context, LEFT_COLUMN_WIDTH);
  const center = renderColumn(modelText, CENTER_COLUMN_WIDTH);
  const centerSecond = renderColumn(thinkingText, CENTER_COLUMN_WIDTH);
  const right = renderUsage(theme, "5h", state.usage, fiveHour);
  const rightSecond = renderUsage(theme, "7d", state.usage, weekly);
  const first = `${left}${center}${right}`;
  const second = `${renderColumn(planText, LEFT_COLUMN_WIDTH)}${centerSecond}${rightSecond}`;
  const renderForeground = (color: RuntimeColor, text: string): string =>
    theme.fg(color, text);
  const hookStatus = extensionStatuses.get("agent-hooks");
  const accountStatus = extensionStatuses.get("codex-account-swap");
  const third = renderRuntimeLine(
    renderForeground,
    ctx.cwd,
    state.activeTools.length,
    hookStatus,
    width,
  );
  const lines = [
    truncateToWidth(first, width),
    truncateToWidth(second, width),
    third,
  ];
  if (accountStatus === undefined) return lines;
  const accountLabel = theme.fg("muted", "Account:");
  const accountColor = accountStatus === "err" ? "error" : "text";
  const accountValue = theme.fg(accountColor, accountStatus);
  const accountLine = `${accountLabel} ${accountValue}`;
  const fourth = truncateToWidth(accountLine, width);
  return [...lines, fourth];
};

const readJson = (response: Response): Promise<unknown> => response.json();

const fetchUsageLimits = async (
  ctx: ExtensionContext,
  provider: string,
  signal: AbortSignal,
): Promise<UsageLimits> => {
  const auth = await ctx.modelRegistry.getProviderAuth(provider);
  signal.throwIfAborted();
  if (auth === undefined)
    throw new Error(`usage companion unavailable: /login ${provider}`);
  const headers = new Headers();
  if (auth.auth.apiKey !== undefined) {
    headers.set("Authorization", `Bearer ${auth.auth.apiKey}`);
  }
  if (auth.auth.headers !== undefined) {
    Object.entries(auth.auth.headers).forEach(([key, value]) => {
      if (value !== null) headers.set(key, value);
    });
  }
  const response = await fetch(USAGE_URL, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(USAGE_TIMEOUT_MS)]),
  });
  if (!response.ok) throw new Error(`usage request failed: ${response.status}`);
  const body = await readJson(response);
  return parseUsageLimits(body);
};

export default function (pi: ExtensionAPI): void {
  let activeTools = new Map<string, string>();
  let requestRender: () => void = () => undefined;
  let refreshLimits: () => Promise<void> = () => Promise.resolve();
  let refreshPlan: () => Promise<void> = () => Promise.resolve();
  let stopSession: () => void = () => undefined;
  let accountChanged: () => void = () => undefined;

  pi.events.on("codex-account-swap:changed", () => {
    accountChanged();
  });
  pi.on("model_select", () => {
    requestRender();
  });
  pi.on("thinking_level_select", () => {
    requestRender();
  });
  pi.on("session_shutdown", () => {
    stopSession();
    accountChanged = () => undefined;
    activeTools.clear();
    requestRender = () => undefined;
    refreshLimits = () => Promise.resolve();
    refreshPlan = () => Promise.resolve();
  });
  pi.on("turn_end", () => {
    refreshLimits().catch(reportUsageRefreshError);
  });
  pi.on("session_tree", () => {
    refreshPlan().catch(reportPlanReadError);
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const path = event.input["path"];
    if (typeof path !== "string") return;
    if (resolve(ctx.cwd, path) !== resolve(ctx.cwd, "PLAN.md")) return;
    refreshPlan().catch(reportPlanReadError);
  });

  pi.on("agent_settled", (event) => {
    if (!event.aborted) return;
    activeTools.clear();
    requestRender();
  });
  pi.on("tool_execution_start", (event) => {
    activeTools.set(event.toolCallId, event.toolName);
    requestRender();
  });
  pi.on("tool_execution_end", (event) => {
    activeTools.delete(event.toolCallId);
    requestRender();
  });

  const startSession = (
    ctx: ExtensionContext,
    invalidateUsage: boolean,
  ): void => {
    stopSession();
    accountChanged = () => undefined;
    activeTools = new Map();
    requestRender = () => undefined;
    refreshLimits = () => Promise.resolve();
    refreshPlan = () => Promise.resolve();
    if (ctx.mode !== "tui") return;
    accountChanged = () => {
      startSession(ctx, true);
    };
    const provider = "openai-codex";
    const cachePath = USAGE_CACHE_PATH;
    const invalidation = invalidateUsage
      ? rm(cachePath, { force: true })
      : Promise.resolve();
    const lockPath = `${cachePath}.lock`;
    const controller = new AbortController();
    const isStopped = (): boolean => controller.signal.aborted;
    let renderSession: () => void = () => undefined;
    const render = (): void => {
      if (isStopped()) return;
      renderSession();
    };
    let state: FooterState = {
      usage: { status: "loading" },
      plan: { status: "loading" },
      activeTools: [],
    };
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshInFlight = false;
    let planReadVersion = 0;
    let unsubscribeBranch: () => void = () => undefined;
    const stop = (): void => {
      if (isStopped()) return;
      controller.abort();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      unsubscribeBranch();
    };
    stopSession = stop;
    const reportedErrors = new Set<string>();
    const reportError = (
      module: string,
      operation: string,
      error: unknown,
    ): void => {
      const message = error instanceof Error ? error.message : String(error);
      const key = `${module}:${operation}:${message}`;
      if (reportedErrors.has(key)) return;
      reportedErrors.add(key);
      logStatusError(module, operation, error).catch(warnLoggingFailure);
    };

    const scheduleRefresh = (delay = USAGE_TTL_MS): void => {
      if (isStopped()) return;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refresh().catch(reportUsageRefreshError);
      }, delay);
    };

    const refreshPlanForSession = async (): Promise<void> => {
      if (isStopped()) return;
      const readVersion = ++planReadVersion;
      const plan = await readPlanProgress(ctx.cwd);
      if (isStopped() || readVersion !== planReadVersion) return;
      if (plan.status === "error") {
        await reportStatusError("plan", "read", plan.message);
      }
      if (isStopped()) return;
      state = { ...state, plan };
      render();
    };

    refreshPlan = refreshPlanForSession;

    const refresh = async (): Promise<void> => {
      if (isStopped() || refreshInFlight) return;
      refreshInFlight = true;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      let cache: UsageCache | undefined;
      try {
        await invalidation;
        if (isStopped()) return;
        cache = await readUsageCache(cachePath);
      } catch (error) {
        if (isStopped()) return;
        await reportStatusError("usage", "cache_read", error);
        await rm(cachePath, { force: true });
        if (isStopped()) return;
        state = {
          ...state,
          usage: { status: "error", message: "usage cache read failed" },
        };
        render();
      }
      if (isStopped()) return;
      if (cache !== undefined) {
        const cacheIsFresh = Date.now() - cache.fetchedAt < USAGE_TTL_MS;
        state = {
          ...state,
          usage: { status: "success", value: cache.limits },
        };
        render();
        if (cacheIsFresh) {
          refreshInFlight = false;
          scheduleRefresh();
          return;
        }
      }
      let lockAcquired = false;
      let refreshDelay = USAGE_TTL_MS;
      try {
        lockAcquired = await acquireUsageLock(lockPath);
        if (isStopped()) return;
        if (!lockAcquired) {
          refreshDelay = USAGE_LOCK_RETRY_MS;
          return;
        }
        const latestCache = await readUsageCache(cachePath);
        if (isStopped()) return;
        if (
          latestCache !== undefined &&
          Date.now() - latestCache.fetchedAt < USAGE_TTL_MS
        ) {
          state = {
            ...state,
            usage: { status: "success", value: latestCache.limits },
          };
          render();
          return;
        }
        const limits = await fetchUsageLimits(ctx, provider, controller.signal);
        if (isStopped()) return;
        await writeUsageCache(cachePath, limits);
        if (isStopped()) return;
        state = {
          ...state,
          usage: { status: "success", value: limits },
        };
        render();
      } catch (error) {
        if (isStopped()) return;
        await reportStatusError("usage", "refresh", error);
        if (isStopped()) return;
        state = {
          ...state,
          usage: { status: "error", message: "usage refresh failed" },
        };
        render();
      } finally {
        if (lockAcquired) await releaseUsageLock(lockPath);
        refreshInFlight = false;
        scheduleRefresh(refreshDelay);
      }
    };

    refreshLimits = refresh;

    ctx.ui.setFooter((tui, theme, footerData) => {
      renderSession = () => {
        state = {
          ...state,
          activeTools: [...activeTools.values()],
        };
        tui.requestRender();
      };
      requestRender = render;
      unsubscribeBranch = footerData.onBranchChange(render);
      return {
        dispose: stop,
        invalidate: () => undefined,
        render: (width) => {
          const extensionStatuses = footerData.getExtensionStatuses();
          return renderFooter(
            ctx,
            theme,
            state,
            width,
            reportError,
            extensionStatuses,
          );
        },
      };
    });

    refresh().catch(reportUsageRefreshError);
    refreshPlanForSession().catch(reportPlanReadError);
  };

  pi.on("session_start", (_event, ctx) => {
    startSession(ctx, false);
  });
}
