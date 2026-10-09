import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CONTEXT_HANDOFF_THRESHOLD = 80;
const HANDOFF_MESSAGE = `Context usage has reached ${CONTEXT_HANDOFF_THRESHOLD}%. Stop regular work now. Update PLAN.md with the current progress, completed work, remaining tasks, important decisions, constraints, verification results, and exact next steps for a fresh session. Do not continue implementation after updating PLAN.md.`;

let handoffQueued = false;

const queueHandoff = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
  if (handoffQueued) return;
  handoffQueued = true;
  ctx.ui.notify(
    `Context usage reached ${CONTEXT_HANDOFF_THRESHOLD}%; requesting PLAN.md handoff`,
    "warning",
  );
  ctx.abort();
  pi.sendUserMessage(HANDOFF_MESSAGE, { deliverAs: "followUp" });
};

const checkContextUsage = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
  if (handoffQueued) return;
  const percent = ctx.getContextUsage()?.percent;
  if (percent === undefined || percent === null) return;
  if (percent < CONTEXT_HANDOFF_THRESHOLD) return;
  queueHandoff(pi, ctx);
};

export default function (pi: ExtensionAPI): void {
  pi.on("turn_end", (_event, ctx) => {
    checkContextUsage(pi, ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!handoffQueued) return;
    ctx.shutdown();
  });
}
