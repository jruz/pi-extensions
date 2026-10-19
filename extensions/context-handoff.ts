import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lastTurnFailed } from "./shared/settled-turn.ts";

const CONTEXT_HANDOFF_THRESHOLD = 80;
const HANDOFF_MESSAGE = `Context usage has reached ${CONTEXT_HANDOFF_THRESHOLD}%. Stop regular work now. Update PLAN.md with the current progress, completed work, remaining tasks, important decisions, constraints, verification results, and exact next steps for a fresh session. Do not continue implementation after updating PLAN.md.`;

export default function (pi: ExtensionAPI): void {
  let handoffRequested = false;
  let shutdownCheck: ReturnType<typeof setImmediate> | undefined;

  const cancelShutdownCheck = (): void => {
    if (shutdownCheck === undefined) return;
    clearImmediate(shutdownCheck);
    shutdownCheck = undefined;
  };

  pi.on("session_start", () => {
    cancelShutdownCheck();
    handoffRequested = false;
  });

  pi.on("session_shutdown", cancelShutdownCheck);
  pi.on("agent_start", cancelShutdownCheck);

  pi.on("turn_end", (event, ctx) => {
    if (handoffRequested || event.outcome !== "completed") return;
    const percent = ctx.getContextUsage()?.percent;
    if (percent === undefined || percent === null) return;
    if (percent < CONTEXT_HANDOFF_THRESHOLD) return;
    handoffRequested = true;
    ctx.ui.notify(
      `Context usage reached ${CONTEXT_HANDOFF_THRESHOLD}%; requesting PLAN.md handoff`,
      "warning",
    );
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "context-handoff",
          content: HANDOFF_MESSAGE,
          display: true,
        },
      ],
      continue: true,
    };
  });

  pi.on("agent_settled", (event, ctx) => {
    cancelShutdownCheck();
    if (!handoffRequested) return;
    const branch = ctx.sessionManager.getBranch();
    if (event.aborted || lastTurnFailed(branch)) {
      handoffRequested = false;
      return;
    }
    shutdownCheck = setImmediate(() => {
      shutdownCheck = undefined;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
      ctx.shutdown();
    });
  });
}
