# Woodpecker CI for Pi

A session-local CI watcher. No daemon or MCP server.

Assume CI access is already configured. Use the tools directly; do not inspect
environment variables or search for credentials.

After pushing, watch the full commit SHA to cover push and tag-release pipelines:

- `woodpecker_watch({ repo: "owner/repo", commit: "<full lowercase 40-character SHA>" })`
- `woodpecker_status({})`
- `woodpecker_unwatch({ repo: "owner/repo", commit: "<same SHA>" })`

Provide exactly one `commit` or `branch`. Branch watching remains available with
`woodpecker_watch({ repo: "owner/repo", branch: "feature" })`; unwatch with the
same branch. Branch mode matches Woodpecker's branch field, not a tag or Git ref.
Commit mode also matches tag pipelines with an empty branch. Cards distinguish
pushes from tags using the event and ref. Push success is not release success.
A watch remains active after push success so a later tag pipeline can appear.

The initial request returns current pipelines. Subsequent polls run every five
seconds and notify the agent when a pipeline appears or changes status. Messages
wait until a busy agent finishes; an idle agent is awakened immediately.

Branch mode checks the latest 20 pipelines for that branch. Commit mode checks
the latest 20 repository pipelines and filters by exact commit. An older commit
outside that window will not be found. Empty results mean awaiting a matching
pipeline, not success. Existing failures are listed in the baseline without
fetching logs; inspect those with the CLI. This is a status watcher, not a durable
event stream: intermediate transitions between polls can be missed.

Stored cards without event/ref metadata remain readable; fresh API responses
require both fields.

Status-change messages use the cards in `presentation.ts`. Failed pipelines fetch
step metadata and logs through the read-only Woodpecker CLI commands in `cli.ts`.
`diagnostics.ts` selects bounded excerpts and omits sensitive-looking lines. The
card shows error lines; the agent also receives surrounding log context and
step-specific commands for the full logs. Raw logs are not persisted.

Failure diagnostics show a muted loading indicator in the footer. Unavailable
diagnostics are reported alongside the known build failure without stopping
status monitoring. CLI requests have a cancellable 30-second timeout per request;
the API retry policy below does not apply to the CLI.

`../chat-preview.ts` uses the same renderer for UI development.

Subscriptions stop on session shutdown, switching sessions, or `/reload`.
Subscribe again afterward. Network failures, timeouts, HTTP 429 and HTTP 5xx
responses receive up to four retries per request, with exponential delays of
1, 2, 4 and 8 seconds plus up to 25% jitter. `Retry-After` seconds and HTTP dates
are respected when they require a longer wait. Each attempt has a 15-second
timeout. Authentication, permission and invalid-response errors are not retried.
Cancellation interrupts requests and retry waits.

Monitoring retains its last snapshot while retrying, then resumes normal polling
after recovery. Exhausted retries or non-retryable failures stop the subscription
and notify the agent with a safe error category or HTTP status. Retry diagnostics
are written to Pi's state log directory as `pi-woodpecker.log`, without credentials,
URLs or response bodies. These retries cover Woodpecker API requests, not Codeberg
webhook delivery.
