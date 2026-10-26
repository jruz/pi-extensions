import { resolve } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  readAccountStatus,
  swapCredentials,
} from "./codex-account-swap/storage.ts";
import { logError } from "./shared/log.ts";

export default function (pi: ExtensionAPI): void {
  const directory = getAgentDir();
  const authPath = resolve(directory, "auth.json");
  let accountNames: readonly string[] = [];
  const refreshAccount = async (ctx: ExtensionContext): Promise<void> => {
    try {
      const status = await readAccountStatus(authPath);
      accountNames = status === undefined ? [] : status.names;
      ctx.ui.setStatus("codex-account-swap", status?.active);
    } catch (error) {
      accountNames = [];
      ctx.ui.setStatus("codex-account-swap", "err");
      await logError("codex-account-swap", error, {
        cwd: ctx.cwd,
        operation: "read",
      });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await refreshAccount(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await refreshAccount(ctx);
  });

  pi.registerCommand("codex-account-swap", {
    description: "Swap Codex credentials between the two configured accounts",
    getArgumentCompletions: (prefix) =>
      accountNames
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        if (!ctx.isIdle())
          throw new Error("account swap: stop the current run first");
        const selection = args.trim();
        const account = await swapCredentials(authPath, selection);
        ctx.ui.setStatus("codex-account-swap", account);
        pi.events.emit("codex-account-swap:changed", { account });
        ctx.ui.notify(
          `Codex account: ${account}. Type continue to resume.`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        await logError("codex-account-swap", error, {
          cwd: ctx.cwd,
          operation: "swap",
        });
      }
    },
  });
}
