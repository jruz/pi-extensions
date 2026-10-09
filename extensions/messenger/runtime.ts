import { randomUUID } from "node:crypto";
import { checkpointPages } from "./checkpoint.ts";
import {
  conversationIdSchema,
  formatCheckpoint,
  formatDelivery,
  formatHistory,
  formatSent,
  messageIdSchema,
  messageSchema,
  type AgentRecord,
  type ConversationId,
  type InboxEntry,
  type InboxStage,
  type MessageId,
  type MessagePriority,
  type MessageRecord,
} from "./protocol.ts";
import type { MessengerTransport } from "./transport.ts";

export type RuntimeOptions = Readonly<{
  transport: MessengerTransport;
  agent: AgentRecord;
  isIdle: () => boolean;
  deliver: (
    content: string,
    mode: "steer" | "followUp",
  ) => void | Promise<void>;
}>;

export type SendOutcome =
  | Readonly<{ type: "sent"; text: string }>
  | Readonly<{ type: "withheld"; text: string }>;

export type ContextTexts = Readonly<{
  user: readonly string[];
  tool: readonly string[];
}>;

type Delivery = Readonly<{
  ids: readonly MessageId[];
  text: string;
  source: "user" | "tool";
}>;

const chronological = (entries: readonly InboxEntry[]): readonly InboxEntry[] =>
  entries.toSorted((left, right) => left.message.sentAt - right.message.sentAt);

const validateReply = (
  inbox: ReadonlyMap<MessageId, InboxEntry>,
  recipientId: ConversationId,
  replyTo: MessageId | undefined,
): void => {
  if (replyTo === undefined) return;
  const id = messageIdSchema.parse(replyTo);
  const original = inbox.get(id);
  if (original?.message.senderId !== recipientId || original.stage !== "read")
    throw new Error(`messenger: invalid or unread reply target: ${replyTo}`);
};

export const createRuntime = (options: RuntimeOptions) => {
  const { transport, agent } = options;
  const inbox = new Map<MessageId, InboxEntry>();
  const history = new Map<MessageId, MessageRecord>();
  const deliveries = new Set<Delivery>();
  const state: { phase: "running" | "stopped"; introduced: boolean } = {
    phase: "running",
    introduced: false,
  };

  const identity = (): AgentRecord => ({
    ...agent,
    status: options.isIdle() ? "idle" : "busy",
  });

  const stopped = (): boolean => state.phase === "stopped";

  const running = (): void => {
    if (stopped()) throw new Error("messenger: session stopped");
  };

  const receive = (instanceId: string, input: MessageRecord): void => {
    running();
    if (instanceId !== agent.instanceId)
      throw new Error("messenger: recipient runtime replaced");
    const message = messageSchema.parse(input);
    if (message.recipientId !== agent.id)
      throw new Error("messenger: wrong recipient");
    inbox.set(message.id, { message, stage: "waiting" });
    history.set(message.id, message);
  };

  const batchContent = (batch: readonly InboxEntry[]): string => {
    const messages = batch.map((entry) => entry.message);
    const introduce =
      !state.introduced &&
      messages.some((message) => message.replyTo === undefined);
    if (introduce) state.introduced = true;
    return formatDelivery(messages, introduce);
  };

  const trackBatch = (
    batch: readonly InboxEntry[],
    stage: InboxStage,
    text: string,
    source: Delivery["source"],
  ): Delivery => {
    batch.forEach(({ message }) => inbox.set(message.id, { message, stage }));
    const delivery = {
      ids: batch.map((entry) => entry.message.id),
      text,
      source,
    };
    deliveries.add(delivery);
    return delivery;
  };

  const injectBatch = async (
    batch: readonly InboxEntry[],
    mode: "steer" | "followUp",
  ): Promise<void> => {
    if (batch.length === 0) return;
    const introduced = state.introduced;
    const text = batchContent(batch);
    const delivery = trackBatch(batch, "injected", text, "user");
    try {
      await options.deliver(text, mode);
    } catch (error) {
      deliveries.delete(delivery);
      batch.forEach((entry) => inbox.set(entry.message.id, entry));
      state.introduced = introduced;
      throw error;
    }
  };

  const inboxEntries = (): readonly InboxEntry[] => {
    const entries = inbox.values();
    return Array.from(entries);
  };

  const checkpoint = (): SendOutcome | undefined => {
    const queued = Array.from(deliveries).find(
      (delivery) =>
        delivery.source === "tool" &&
        delivery.ids.some((id) => inbox.get(id)?.stage !== "read"),
    );
    if (queued !== undefined) return { type: "withheld", text: queued.text };
    const unread = inboxEntries().filter((entry) => entry.stage !== "read");
    const batch = chronological(unread);
    if (batch.length === 0) return undefined;
    const content = batchContent(batch);
    const pages = checkpointPages(content);
    const prepared = pages.map((page, index) => {
      const part =
        pages.length === 1
          ? ""
          : `Waiting batch part ${index + 1} of ${pages.length}. The draft remains withheld until every part is read.\n\n`;
      const text = formatCheckpoint(`${part}${page}`);
      return trackBatch(batch, "checkpoint", text, "tool");
    });
    const first = prepared[0];
    if (first === undefined)
      throw new Error("messenger: empty checkpoint batch");
    return { type: "withheld", text: first.text };
  };

  return {
    identity,
    start: (): Promise<void> => transport.start(identity, receive),
    peers: async (): Promise<readonly AgentRecord[]> => {
      running();
      const agents = await transport.peers();
      return agents.filter((peer) => peer.id !== agent.id);
    },
    poll: async (): Promise<void> => {
      if (state.phase === "stopped") return;
      const waiting = inboxEntries().filter(
        (entry) => entry.stage === "waiting",
      );
      const urgent = waiting.filter(
        (entry) => entry.message.priority === "urgent",
      );
      const orderedUrgent = chronological(urgent);
      await injectBatch(orderedUrgent, "steer");
      if (stopped() || !options.isIdle()) return;
      const normal = inboxEntries().filter(
        (entry) =>
          entry.stage === "waiting" && entry.message.priority === "normal",
      );
      const orderedNormal = chronological(normal);
      await injectBatch(orderedNormal, "followUp");
    },
    recordContext: (texts: ContextTexts): void => {
      if (state.phase === "stopped") return;
      Array.from(deliveries).forEach((delivery) => {
        if (!texts[delivery.source].includes(delivery.text)) return;
        deliveries.delete(delivery);
        delivery.ids.forEach((id) => {
          const remaining = Array.from(deliveries).some(
            (part) => part.source === "tool" && part.ids.includes(id),
          );
          if (delivery.source === "tool" && remaining) return;
          const entry = inbox.get(id);
          if (entry !== undefined) inbox.set(id, { ...entry, stage: "read" });
        });
      });
    },
    send: async (
      recipientId: ConversationId,
      text: string,
      priority: MessagePriority,
      replyTo: MessageId | undefined,
    ): Promise<SendOutcome> => {
      running();
      const recipient = conversationIdSchema.parse(recipientId);
      if (recipient === agent.id)
        throw new Error("messenger: cannot send to yourself");
      const message = messageSchema.parse({
        id: randomUUID(),
        senderId: agent.id,
        senderProjectPath: agent.projectPath,
        recipientId: recipient,
        message: text,
        priority,
        replyTo,
        sentAt: Date.now(),
      });
      const initial = checkpoint();
      if (initial !== undefined) return initial;
      validateReply(inbox, recipient, replyTo);
      const target = await transport.identity(recipient);
      running();
      const waiting = checkpoint();
      if (waiting !== undefined) return waiting;
      await transport.send(target, message);
      running();
      history.set(message.id, message);
      return { type: "sent", text: formatSent(target, text, priority) };
    },
    history: (limit: number, offset: number): string => {
      const entries = history.values();
      const messages = Array.from(entries);
      return formatHistory(agent.id, messages, limit, offset);
    },
    stop: async (): Promise<void> => {
      if (state.phase === "stopped") return;
      state.phase = "stopped";
      inbox.clear();
      history.clear();
      deliveries.clear();
      await transport.stop();
    },
  };
};

export type MessengerRuntime = ReturnType<typeof createRuntime>;
