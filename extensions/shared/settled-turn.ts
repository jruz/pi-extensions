import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

type AssistantEntry = SessionMessageEntry & { message: AssistantMessage };

const FAILED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> =
  new Set(["error", "aborted"]);

const isAssistantEntry = (entry: SessionEntry): entry is AssistantEntry =>
  entry.type === "message" && entry.message.role === "assistant";

export const lastTurnFailed = (entries: readonly SessionEntry[]): boolean => {
  const lastAssistant = entries.findLast(isAssistantEntry);
  if (lastAssistant === undefined) return false;
  return FAILED_STOP_REASONS.has(lastAssistant.message.stopReason);
};
