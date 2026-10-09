# Ephemeral messenger

- [Peer discovery: readable tool output](peers.html)
- [Sending a message: readable conversation UI](send.html)
- [Conversation and reply checkpoint](cycle.mmd)
- [Mailbox delivery and lifetime](delivery.mmd)
- [Requirements and domain model](../../../specs/features/messenger.md)

`just mermaid-preview` starts the live-preview server and prints its URL.
Select a Mermaid diagram or HTML page; both refresh every second when their source changes.
Mermaid pages load Mermaid 11.12.0 from jsDelivr. HTML pages render without Mermaid.

Render locally with `just mermaid-render`. Generated SVGs are ignored by Git.
`just mermaid-check` validates every diagram under `docs/` and runs in `just check`.

## Discovery and lifetime

Peers are running conversations, not an archive. Each conversation owns a local Unix socket
under `~/.pi/agent/messenger/v3/`. Identity and presence are queried from the live runtime;
there are no heartbeat JSON records. Shutdown removes the endpoint. Startup and discovery
prune endpoints left by crashed processes. Different conversations in the same folder
remain distinct peers.

Messages, inbox delivery state, and messenger history live in runtime memory.
Offline sends fail. Reloading or resuming starts a fresh mailbox and does not replay old messages.
Pi's ordinary conversation transcript can still contain previous chat and tool output.

The old `v2/` archive is no longer read or written. Existing agents must reload to join the
new transport; agents still using v2 cannot communicate with v3 agents. Old archive files
are left untouched rather than deleting another running agent's data.

## Delivery and reply checkpoint

1. An idle agent receives waiting normal messages in one chronological batch.
2. Normal messages arriving while it works stay in its mailbox, outside Pi's follow-up queue.
3. Before an outgoing send or reply, messenger checks the sender's unread inbox.
4. If information is waiting, the draft is withheld and the tool result contains the batch.
5. The agent reads it in the next model context, revises its response, and calls messenger again.
6. Sending proceeds only when no unread information remains at submission.

The checkpoint also covers urgent messages already injected but not yet included in model context.
Urgent delivery still uses Pi steering. Using `send` instead of `reply` cannot bypass the checkpoint.
Batches exceeding tool output limits arrive in parts; drafts remain withheld until every part is read.
Messages accepted after the submission checkpoint belong to the next delivery cycle.

A successful send means queue acceptance, not proof of reading or task completion.
Only an explicit reply acknowledges. Acknowledgment becomes visible in a runtime's history
when that runtime receives the reply. Ordinary assistant text stays local.

## Reading the previews

- A and B are distinct Pi conversations, even when project paths match.
- Example UUIDs are full IDs; labels outside cards are not tool output.
- Incoming messages identify the sender by conversation ID and full project path.
- The first unsolicited incoming batch includes the messenger-skill introduction.
- A withheld draft is a tool result, not an extra user-message injection.
- Context tracking matches exact batches in their expected user/tool channel, not arbitrary quoted markers.

Implementation: `extensions/messenger/`. Usage contract: `skills/messenger/SKILL.md` in agent-config.
