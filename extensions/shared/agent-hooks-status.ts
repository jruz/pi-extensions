type HookStatusColor = "error" | "success" | "warning";

type HookStatusTheme = Readonly<{
  fg: (color: HookStatusColor, text: string) => string;
}>;

export type HookStatusContext = Readonly<{
  ui: Readonly<{
    theme: HookStatusTheme;
    setStatus: (key: string, value: string) => void;
  }>;
}>;

export type HookStatus = Readonly<{
  startSession: (ctx: HookStatusContext) => void;
  stopSession: () => void;
  currentGeneration: () => number;
  isSessionActive: (generation: number) => boolean;
  showPending: (
    ctx: HookStatusContext,
    generation: number,
    name: string,
  ) => void;
  showResult: (
    ctx: HookStatusContext,
    generation: number,
    name: string,
    status: "success" | "failure",
  ) => void;
}>;

type Schedule<Timer> = (callback: () => void, duration: number) => Timer;
type Cancel<Timer> = (timer: Timer) => void;

const HOOK_STATUS_KEY = "agent-hooks";
const HOOK_STATUS_DURATION_MS = 3000;

export const createHookStatus = <Timer>(
  schedule: Schedule<Timer>,
  cancel: Cancel<Timer>,
): HookStatus => {
  let timer: Timer | undefined;
  let generation = 0;
  let active = false;

  const clearTimer = (): void => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };

  const isSessionActive = (candidate: number): boolean =>
    active && candidate === generation;

  const startSession = (ctx: HookStatusContext): void => {
    clearTimer();
    generation += 1;
    active = true;
    ctx.ui.setStatus(HOOK_STATUS_KEY, "");
  };

  const stopSession = (): void => {
    clearTimer();
    generation += 1;
    active = false;
  };

  const showPending = (
    ctx: HookStatusContext,
    candidate: number,
    name: string,
  ): void => {
    if (!isSessionActive(candidate)) return;
    clearTimer();
    const symbol = ctx.ui.theme.fg("warning", "●");
    ctx.ui.setStatus(HOOK_STATUS_KEY, `${name} ${symbol}`);
  };

  const showResult = (
    ctx: HookStatusContext,
    candidate: number,
    name: string,
    status: "success" | "failure",
  ): void => {
    if (!isSessionActive(candidate)) return;
    clearTimer();
    const symbol =
      status === "success"
        ? ctx.ui.theme.fg("success", "✓")
        : ctx.ui.theme.fg("error", "✗");
    ctx.ui.setStatus(HOOK_STATUS_KEY, `${name} ${symbol}`);
    timer = schedule(() => {
      if (!isSessionActive(candidate)) return;
      timer = undefined;
      ctx.ui.setStatus(HOOK_STATUS_KEY, "");
    }, HOOK_STATUS_DURATION_MS);
  };

  return {
    startSession,
    stopSession,
    currentGeneration: () => generation,
    isSessionActive,
    showPending,
    showResult,
  };
};
