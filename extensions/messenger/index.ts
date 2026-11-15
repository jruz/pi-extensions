import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatPeers, POLL_INTERVAL_MS, type AgentRecord } from "./protocol.ts";
import {
  createRuntime,
  type MessengerRuntime,
  type SendOutcome,
} from "./runtime.ts";
import { createTransport } from "./transport.ts";

const home = homedir();
const projectRoot = resolve(home, "dev/projects");
const socketDirectory = join(home, ".pi/agent/messenger/v3");
const actions = Type.Enum(["me", "peers", "history", "send", "reply"], {
  type: "string",
});
const agentReference = Type.String({
  description: "Full UUID; shortened IDs are not accepted.",
  minLength: 1,
});
const message = Type.String({ maxLength: 8000, minLength: 1 });
const priorities = Type.Enum(["normal", "urgent"], { type: "string" });
const limit = Type.Integer({ maximum: 100, minimum: 1 });
const offset = Type.Integer({ minimum: 0 });
const parameters = Type.Object({
  action: actions,
  limit: Type.Optional(limit),
  message: Type.Optional(message),
  offset: Type.Optional(offset),
  priority: Type.Optional(priorities),
  replyTo: Type.Optional(agentReference),
  to: Type.Optional(agentReference),
});

const result = (text: string) => {
  const truncated = truncateHead(text);
  const content = truncated.truncated
    ? `${truncated.content}\nOutput truncated; use a smaller history limit and page with offset.`
    : text;
  return { content: [{ text: content, type: "text" as const }], details: {} };
};

const send = async (
  runtime: MessengerRuntime,
  params: Static<typeof parameters>,
): Promise<SendOutcome> => {
  if (params.to === undefined) throw new Error("messenger: to is required");
  if (params.message === undefined)
    throw new Error("messenger: message is required");
  if (params.action === "reply" && params.replyTo === undefined)
    throw new Error("messenger: replyTo is required for replies");
  const priority = params.priority === undefined ? "normal" : params.priority;
  return runtime.send(params.to, params.message, priority, params.replyTo);
};

export default function messenger(pi: ExtensionAPI): void {
  let state:
    | Readonly<{
        agent: AgentRecord;
        runtime: MessengerRuntime;
        timer: ReturnType<typeof setInterval>;
      }>
    | undefined;
  const reportError = (error: unknown): void => {
    process.emitWarning(
      `messenger: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  pi.registerTool({
    description:
      "Identify your conversation with me, discover online peers, send or reply using full IDs, and read current-runtime history. Normal messages batch while busy; urgent messages steer. Sending with unread incoming messages withholds the draft and returns the waiting batch: review it and retry with an updated response. Offline sends fail. Queues/history disappear on reload or shutdown. History defaults to 20; limit 1–100 and offset page older messages. Text is limited to 8000 characters. Only an explicit reply acknowledges.",
    async execute(_id, params) {
      try {
        if (state === undefined)
          throw new Error("messenger: agent is not registered");
        const { agent, runtime } = state;
        switch (params.action) {
          case "me": {
            const identity = JSON.stringify({
              agentId: agent.id,
              display: agent.projectPath,
              instanceId: agent.instanceId,
              projectPath: agent.projectPath,
              sessionId: agent.id,
            });
            return result(identity);
          }
          case "peers": {
            const peers = await runtime.peers();
            const peerText = formatPeers(peers);
            return result(peerText);
          }
          case "history": {
            const limit = params.limit === undefined ? 20 : params.limit;
            const offset = params.offset === undefined ? 0 : params.offset;
            const history = runtime.history(limit, offset);
            return result(history);
          }
          case "send":
          case "reply": {
            const response = await send(runtime, params);
            return result(response.text);
          }
        }
      } catch (error) {
        reportError(error);
        throw error;
      }
    },
    exposure: "model-only",
    label: "Messenger",
    name: "messenger",
    parameters,
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.cwd !== projectRoot && !ctx.cwd.startsWith(`${projectRoot}${sep}`))
      return;
    try {
      const agent: AgentRecord = {
        id: ctx.sessionManager.getSessionId(),
        instanceId: randomUUID(),
        projectPath: ctx.cwd,
        status: ctx.isIdle() ? "idle" : "busy",
      };
      const runtime = createRuntime({
        agent,
        deliver: (content, mode) => {
          pi.sendUserMessage(content, { deliverAs: mode });
        },
        isIdle: () => ctx.isIdle(),
        transport: createTransport(socketDirectory, reportError),
      });
      await runtime.start();
      const timer = setInterval(() => {
        runtime.poll().catch(reportError);
      }, POLL_INTERVAL_MS);
      state = { agent, runtime, timer };
    } catch (error) {
      reportError(error);
      ctx.ui.notify(`Messenger failed to start: ${String(error)}`, "error");
      throw error;
    }
  });

  pi.on("context", (event) => {
    if (state === undefined) return;
    const user = event.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => {
        if (typeof message.content === "string") return [message.content];
        return message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text);
      });
    const tool = event.messages.flatMap((message) => {
      if (message.role !== "toolResult" || message.toolName !== "messenger")
        return [];
      return message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text);
    });
    state.runtime.recordContext({ tool, user });
  });

  pi.on("session_shutdown", async () => {
    if (state === undefined) return;
    const previous = state;
    state = undefined;
    clearInterval(previous.timer);
    await previous.runtime.stop();
  });
}
