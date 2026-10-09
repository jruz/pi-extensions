import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PI_LOG_DIRECTORY } from "../shared/log-path.ts";
import { changedPipelines, createClient, type Pipeline } from "./client.ts";

import { formatWatchBaseline } from "./baseline.ts";
import { createCliRunner } from "./cli.ts";
import {
  notificationSchema,
  publishUpdates,
  type Notification,
} from "./notifications.ts";
import { renderNotification } from "./presentation.ts";
import { requestError } from "./request.ts";
import {
  formatWatchTarget,
  subscriptionKey,
  watchTargetSchema,
  type WatchTarget,
} from "./target.ts";

type Subscription = Readonly<{
  repo: string;
  target: WatchTarget;
  controller: AbortController;
  stop: () => void;
}>;

const reportError = (message: string) => {
  try {
    const path = join(PI_LOG_DIRECTORY, "pi-woodpecker.log");
    mkdirSync(PI_LOG_DIRECTORY, { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
  } catch (error) {
    throw new Error(
      "woodpecker: request failed and diagnostic log could not be written",
      { cause: error },
    );
  }
};

const readTarget = (input: unknown): WatchTarget => {
  try {
    return watchTargetSchema.parse(input);
  } catch (error) {
    const reason =
      "woodpecker: provide exactly one branch or full lowercase 40-character commit SHA";
    reportError(reason);
    throw new Error(reason, { cause: error });
  }
};

const branchParameter = Type.String({
  minLength: 1,
  description:
    "Exact Woodpecker branch field. Use either branch or commit, not both.",
});
const commitParameter = Type.String({
  pattern: "^[a-f0-9]{40}$",
  description:
    "Full commit SHA to watch across push and tag pipelines. Use either commit or branch, not both.",
});
const watchParameters = Type.Object({
  repo: Type.String({ minLength: 1 }),
  branch: Type.Optional(branchParameter),
  commit: Type.Optional(commitParameter),
});

export default (pi: ExtensionAPI) => {
  pi.registerMessageRenderer(
    "woodpecker-ci",
    (message, { outputPad }, theme) => {
      const notification = notificationSchema.parse(message.details);
      return renderNotification(notification, theme, outputPad);
    },
  );
  const notify = (content: string, details: Notification) => {
    pi.sendMessage(
      { customType: "woodpecker-ci", content, details, display: true },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };
  const subscriptions = new Map<string, Subscription>();
  const snapshots = new Map<string, readonly Pipeline[]>();
  const pending = new Map<string, AbortController>();
  const result = (text: string) => ({
    content: [{ type: "text" as const, text }],
    details: {},
  });
  const stop = (key: string) => {
    pending.get(key)?.abort();
    pending.delete(key);
    subscriptions.get(key)?.stop();
    subscriptions.delete(key);
    snapshots.delete(key);
  };

  pi.registerTool({
    name: "woodpecker_watch",
    label: "Watch CI",
    description:
      "Subscribe this session to Woodpecker CI status changes for a repository and either an exact branch or full commit SHA. Prefer commit after pushing to capture both push and later tag-release pipelines. Branch mode does not match tags. Polls every five seconds over the latest 20 pipelines. Existing pipelines are a baseline, not replayed as alerts. Push success does not imply release success. Subscriptions end on session close or reload.",
    parameters: watchParameters,
    async execute(_id, { repo, branch, commit }, signal, _onUpdate, ctx) {
      const target = readTarget({ branch, commit });
      const label = formatWatchTarget(target);
      const key = subscriptionKey(repo, target);
      if (subscriptions.has(key) || pending.has(key))
        return result(`Already watching ${repo} ${label}`);
      const controller = new AbortController();
      const loadingKey = `woodpecker-logs:${key}`;
      const loading = (active: boolean) => {
        if (!ctx.hasUI || controller.signal.aborted) return;
        const label = active
          ? ctx.ui.theme.fg("muted", `Loading CI failure logs for ${repo}…`)
          : undefined;
        ctx.ui.setStatus(loadingKey, label);
      };
      pending.set(key, controller);
      try {
        const client = createClient(reportError);
        const initialSignal =
          signal === undefined
            ? controller.signal
            : AbortSignal.any([signal, controller.signal]);
        const repoId = await client.repo(repo, initialSignal);
        const initial = await client.pipelines(repoId, target, initialSignal);
        initialSignal.throwIfAborted();
        pending.delete(key);
        snapshots.set(key, initial);
        const exec = pi.exec.bind(pi);
        const run = createCliRunner(exec, controller.signal);
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const poll = async (): Promise<void> => {
          try {
            const current = await client.pipelines(
              repoId,
              target,
              controller.signal,
            );
            if (controller.signal.aborted) return;
            const previous = snapshots.get(key);
            if (previous === undefined)
              throw new Error("woodpecker: missing subscription snapshot");
            const changes = changedPipelines(previous, current);
            snapshots.set(key, current);
            if (changes.length > 0)
              await publishUpdates(
                { run, report: reportError, loading, send: notify },
                repo,
                changes,
                controller.signal,
              );
            schedule();
          } catch (error) {
            if (controller.signal.aborted) return;
            const reason = requestError(error);
            reportError(reason);
            stop(key);
            pi.sendMessage(
              {
                customType: "woodpecker",
                content: `Woodpecker CI monitoring stopped for ${repo} ${label}: ${reason}. Subscribe again to resume.`,
                display: true,
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          }
        };
        const schedule = () => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            poll().catch((error: unknown) => {
              const reason = requestError(error);
              reportError(reason);
            });
          }, 5000);
          timer.unref();
          timers.add(timer);
        };
        subscriptions.set(key, {
          repo,
          target,
          controller,
          stop: () => {
            if (ctx.hasUI) ctx.ui.setStatus(loadingKey, undefined);
            controller.abort();
            timers.forEach(clearTimeout);
            timers.clear();
          },
        });
        schedule();
        const text = formatWatchBaseline(repo, target, initial);
        return result(text);
      } catch (error) {
        if (pending.get(key) === controller) pending.delete(key);
        const cancelled = controller.signal.aborted || signal?.aborted;
        controller.abort();
        if (cancelled)
          throw new Error("woodpecker: subscription cancelled", {
            cause: error,
          });
        const reason = requestError(error);
        reportError(reason);
        throw new Error(`woodpecker: subscription failed; ${reason}`, {
          cause: error,
        });
      }
    },
  });

  pi.registerTool({
    name: "woodpecker_unwatch",
    label: "Unwatch CI",
    description:
      "Stop this session's Woodpecker subscription for a repository and the same branch or commit used to subscribe.",
    parameters: watchParameters,
    execute(_id, { repo, branch, commit }) {
      const target = readTarget({ branch, commit });
      const key = subscriptionKey(repo, target);
      stop(key);
      const response = result(
        `Stopped watching ${repo} ${formatWatchTarget(target)}`,
      );
      return Promise.resolve(response);
    },
  });

  pi.registerTool({
    name: "woodpecker_status",
    label: "CI subscriptions",
    description:
      "List this session's active CI subscriptions and their most recently polled pipeline statuses.",
    parameters: Type.Object({}),
    execute() {
      const subscriptionsIterator = subscriptions.entries();
      const entries = Array.from(subscriptionsIterator).map(
        ([key, subscription]) => ({
          repo: subscription.repo,
          [subscription.target.kind]: subscription.target.value,
          pipelines: snapshots.get(key),
        }),
      );
      const text = JSON.stringify(entries);
      const response = result(text);
      return Promise.resolve(response);
    },
  });

  pi.on("session_shutdown", () => {
    const pendingKeys = pending.keys();
    const subscriptionKeys = subscriptions.keys();
    Array.from(pendingKeys).forEach(stop);
    Array.from(subscriptionKeys).forEach(stop);
  });
};
