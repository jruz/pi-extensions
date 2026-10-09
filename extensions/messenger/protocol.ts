import { z } from "zod";

export const POLL_INTERVAL_MS = 1_000;
export const REQUEST_TIMEOUT_MS = 2_000;

export const conversationIdSchema = z.uuid();
export type ConversationId = z.infer<typeof conversationIdSchema>;
export const messageIdSchema = z.uuid();
export type MessageId = z.infer<typeof messageIdSchema>;

const agentSchema = z
  .object({
    id: conversationIdSchema,
    instanceId: z.uuid(),
    projectPath: z.string(),
    status: z.enum(["busy", "idle"]),
  })
  .readonly();

export const messageSchema = z
  .object({
    id: messageIdSchema,
    senderId: conversationIdSchema,
    senderProjectPath: z.string(),
    recipientId: conversationIdSchema,
    message: z.string().min(1).max(8000),
    priority: z.enum(["normal", "urgent"]),
    replyTo: messageIdSchema.optional(),
    sentAt: z.number(),
  })
  .readonly();

export const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("me") }).readonly(),
  z
    .object({
      action: z.literal("receive"),
      instanceId: z.uuid(),
      message: messageSchema,
    })
    .readonly(),
]);

export const responseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("identity"), agent: agentSchema }).readonly(),
  z.object({ type: z.literal("accepted") }).readonly(),
  z.object({ type: z.literal("error"), message: z.string() }).readonly(),
]);

export type AgentRecord = z.infer<typeof agentSchema>;
export type MessageRecord = z.infer<typeof messageSchema>;
export type MessagePriority = MessageRecord["priority"];
export type TransportRequest = z.infer<typeof requestSchema>;
export type TransportResponse = z.infer<typeof responseSchema>;
export type InboxStage = "waiting" | "injected" | "checkpoint" | "read";
export type InboxEntry = Readonly<{
  message: MessageRecord;
  stage: InboxStage;
}>;

const messageMarker = (id: MessageId): string => `message-id: ${id}`;

const formatPeer = (peer: AgentRecord): string =>
  `id: ${peer.id}\nproject: ${peer.projectPath}\nstatus: ${peer.status}`;

export const formatPeers = (peers: readonly AgentRecord[]): string => {
  if (peers.length === 0) return "No online peers.";
  return peers.map(formatPeer).join("\n\n");
};

export const formatSent = (
  recipient: AgentRecord,
  message: string,
  priority: MessagePriority,
): string =>
  `to: ${recipient.id}\nproject: ${recipient.projectPath}\npriority: ${priority}\nmessage:\n${message}`;

export const formatReceived = (message: MessageRecord): string => {
  const marker = messageMarker(message.id);
  const reply =
    message.replyTo === undefined ? "" : `\nreply-to: ${message.replyTo}`;
  return `${marker}\nfrom: ${message.senderId}\nproject: ${message.senderProjectPath}\npriority: ${message.priority}${reply}\nmessage:\n${message.message}`;
};

export const formatDelivery = (
  messages: readonly MessageRecord[],
  introduce: boolean,
): string => {
  const content = messages.map(formatReceived).join("\n\n");
  if (!introduce) return content;
  return `This message is from another Pi agent. Read the messenger skill before responding.\n\n${content}`;
};

export const formatCheckpoint = (content: string): string =>
  `Message NOT sent. Read these waiting messages, reconsider your draft, then call messenger again to send your updated response.\n\n${content}`;

const messageStatus = (
  message: MessageRecord,
  messages: readonly MessageRecord[],
): "queued" | "acknowledged" =>
  messages.some(
    (reply) =>
      reply.replyTo === message.id &&
      reply.senderId === message.recipientId &&
      reply.recipientId === message.senderId,
  )
    ? "acknowledged"
    : "queued";

export const formatHistory = (
  agentId: ConversationId,
  messages: readonly MessageRecord[],
  limit: number,
  offset: number,
): string => {
  const relevant = messages.toSorted(
    (left, right) =>
      right.sentAt - left.sentAt || left.id.localeCompare(right.id),
  );
  const page = relevant.slice(offset, offset + limit);
  const lines = page.map(
    (message) =>
      `${new Date(message.sentAt).toISOString()} ${message.senderId === agentId ? "sent" : "received"} ${messageStatus(message, messages)} id=${message.id} from=${message.senderId} to=${message.recipientId} replyTo=${message.replyTo === undefined ? "none" : message.replyTo}\n${message.message}`,
  );
  return `${lines.join("\n")}\nShowing ${page.length} of ${relevant.length}; offset=${offset}. History exists only until reload or shutdown.`;
};
