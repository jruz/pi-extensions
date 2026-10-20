import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lastTurnFailed } from "./shared/settled-turn.ts";

const CONTEXT_HANDOFF_THRESHOLD = 80;
const HANDOFF_MESSAGE = `Context usage has reached the ${CONTEXT_HANDOFF_THRESHOLD}% limit. Stop regular work now. Update PLAN.md with the current progress so it can be continued with a fresh start. Do not continue implementation after updating PLAN.md.`;
const CONTINUATION_COMMAND = "context-handoff-continue";
const CONTINUATION_MESSAGE = "Read PLAN.md and continue the plan.";

export default function (pi: ExtensionAPI): void {
  let handoffRequested = false;
  let continuationQueued = false;

  const reset = (): void => {
    handoffRequested = false;
    continuationQueued = false;
  };

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);

  pi.registerCommand(CONTINUATION_COMMAND, {
    description: "Continue a completed context handoff in a fresh session",
    handler: async (_args, ctx) => {
      if (!handoffRequested || !continuationQueued) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        continuationQueued = false;
        return;
      }
      const parentSession = ctx.sessionManager.getSessionFile();
      reset();
      try {
        const result = await ctx.newSession({
          ...(parentSession === undefined ? {} : { parentSession }),
          withSession: async (replacementCtx) => {
            await replacementCtx.sendUserMessage(CONTINUATION_MESSAGE);
          },
        });
        if (result.cancelled) {
          ctx.ui.notify(
            "Context handoff session replacement cancelled",
            "warning",
          );
        }
      } catch (error) {
        const warning = new Error(
          "Context handoff session replacement failed",
          {
            cause: error,
          },
        );
        process.emitWarning(warning);
        throw error;
      }
    },
  });

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
    if (!handoffRequested) return;
    const branch = ctx.sessionManager.getBranch();
    if (event.aborted || lastTurnFailed(branch)) {
      reset();
      return;
    }
    if (continuationQueued) return;
    continuationQueued = true;
    pi.sendUserMessage(`/${CONTINUATION_COMMAND}`, {
      expandPromptTemplates: true,
    });
  });
}
