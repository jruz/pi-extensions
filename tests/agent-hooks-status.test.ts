import { describe, expect, test } from "vitest";
import {
  createHookStatus,
  type HookStatusContext,
} from "../extensions/shared/agent-hooks-status.ts";

type ScheduledTimer = Readonly<{
  callback: () => void;
  duration: number;
}>;

type ContextState = {
  stale: boolean;
  statuses: string[];
};

const createContext = (state: ContextState): HookStatusContext => ({
  get ui() {
    if (state.stale) throw new Error("stale context");
    return {
      theme: {
        fg: (_color: "error" | "success" | "warning", text: string) => text,
      },
      setStatus: (_key: string, value: string) => state.statuses.push(value),
    };
  },
});

const createStatusHarness = () => {
  const scheduled: ScheduledTimer[] = [];
  const cancelled = new Set<ScheduledTimer>();
  const status = createHookStatus(
    (callback, duration): ScheduledTimer => {
      const timer = { callback, duration };
      scheduled.push(timer);
      return timer;
    },
    (timer) => {
      cancelled.add(timer);
    },
  );
  return { cancelled, scheduled, status };
};

describe("agent hook status lifecycle", () => {
  test("does not clear status through a stale context after shutdown", () => {
    const { cancelled, scheduled, status } = createStatusHarness();
    const state: ContextState = { stale: false, statuses: [] };
    const ctx = createContext(state);
    status.startSession(ctx);
    const generation = status.currentGeneration();
    status.showResult(ctx, generation, "stop", "success");
    const timer = scheduled[0];
    if (timer === undefined) throw new Error("status timer was not scheduled");

    status.stopSession();
    state.stale = true;

    const timerWasCancelled = cancelled.has(timer);
    expect(timerWasCancelled).toBe(true);
    expect(timer.callback).not.toThrow();
    expect(state.statuses).toEqual(["", "stop ✓"]);
  });

  test("ignores hook completion from the replaced session", () => {
    const { status } = createStatusHarness();
    const oldState: ContextState = { stale: false, statuses: [] };
    const oldContext = createContext(oldState);
    status.startSession(oldContext);
    const oldGeneration = status.currentGeneration();
    status.stopSession();
    oldState.stale = true;

    const newState: ContextState = { stale: false, statuses: [] };
    const newContext = createContext(newState);
    status.startSession(newContext);

    expect(() => {
      status.showResult(oldContext, oldGeneration, "stop", "success");
    }).not.toThrow();
    expect(oldState.statuses).toEqual([""]);
    expect(newState.statuses).toEqual([""]);
  });
});
