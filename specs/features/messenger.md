# Ephemeral messenger

## Overview

Messenger connects running Pi conversations on this machine. Its queues and history live only in the current extension runtime.

## Requirements

THE messenger SHALL discover only reachable running conversations.

THE messenger SHALL exclude the caller from peer discovery.

THE messenger SHALL identify conversations by full session UUIDs.

THE messenger SHALL allow only one runtime to own a conversation endpoint.

WHEN a runtime shuts down, THE messenger SHALL remove its endpoint.

WHEN discovery finds a crashed endpoint, THE messenger SHALL remove it.

IF a recipient is unavailable, THEN THE messenger SHALL reject the send clearly.

WHILE a recipient is working, THE messenger SHALL hold normal incoming messages in its inbox.

WHEN the recipient becomes idle, THE messenger SHALL deliver its waiting normal messages as one chronological batch.

WHEN urgent messages arrive, THE messenger SHALL deliver them through Pi steering.

WHEN a conversation attempts an outgoing send with unread incoming messages, THE messenger SHALL withhold the outgoing draft.

WHEN an outgoing draft is withheld, THE messenger SHALL return the unread messages together in the tool result.

WHEN a draft is withheld, THE messenger SHALL instruct the agent to review the batch before retrying.

WHEN the next model context includes a delivered batch, THE messenger SHALL mark that batch read.

IF a waiting batch exceeds tool output limits, THEN THE messenger SHALL return it in consecutive parts.

WHILE parts of a waiting batch remain unread, THE messenger SHALL continue withholding outgoing drafts.

WHEN a send has no unread incoming messages at its submission checkpoint, THE messenger SHALL submit the outgoing message.

IF messages arrive after the submission checkpoint, THEN THE messenger SHALL retain them for the next delivery checkpoint.

WHEN a runtime is reloaded, THE messenger SHALL discard its mailbox.

THE messenger SHALL retain history only in runtime memory.

THE messenger SHALL treat only explicit replies as acknowledgments.

## Domain model

- Conversation entity: session UUID, runtime UUID, project path, presence (`idle`, `busy`).
- Message entity: message UUID, sender identity/path, recipient identity, text, priority, optional reply target, timestamp.
- Inbox entry: message plus delivery stage (`waiting`, `injected`, `checkpoint`, `read`).
- Runtime lifecycle: `running` → `stopped`; restarting creates a new runtime.
- Message lifecycle: `waiting` → `injected` or `checkpoint` → `read`; runtime shutdown discards all entries.
- Commands: register, receive, deliver batch, submit draft, record model context, stop.
- Queries: identity, live peers, current-runtime history.
- Calculations: batching, formatting, reply validation, acknowledgment status.
- Failures: invalid UUID/text/reply target, duplicate ownership, offline recipient, replaced runtime, transport failure, Pi injection failure. Failures are reported rather than converted into successful sends.
- Invariants: only read incoming messages may be replied to; withholding a draft sends nothing; retries never automatically submit the withheld text; pending messages remain private to the owning runtime.

## Workflows

Receive: validate envelope → check runtime identity → add to in-memory inbox → acknowledge queue acceptance.

Deliver: select eligible waiting entries → format chronological batch → inject through Pi → track batch until model context.

Send: validate recipient/reply → resolve live runtime → check unread inbox → return withheld draft with batch, or submit envelope → record successful outgoing message.

Discovery: scan local conversation endpoints → query live identity → discard unreachable crashed endpoints → exclude caller → format peers.

The checkpoint covers messages accepted before submission, not messages still in transit. Normal delivery stays outside Pi's busy follow-up queue so the reply checkpoint can retrieve it. Urgent injections that have not reached context are also included by the checkpoint.
