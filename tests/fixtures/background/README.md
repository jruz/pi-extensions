# Background backend probes

These are prototypes, not a registered Pi tool. Commands are caller-supplied; none of the fixtures imports sandbox tooling. Dependency tooling and Vitest run through `sandbox`. The explicitly approved dependency-free host harness and its audited fixtures run directly with native Node; host tmux orchestration is separate from Vitest.

## Dependency-free host integration tests

```bash
just background-test /nix/store/a6wmp2d9v6s39lbsvsb8dssdahdbfc05-nodejs-24.14.1/bin/node
```

Node 24 is required. The executable above is verified in this environment; if unavailable, re-establish an explicit Node 24 path rather than silently choosing another executable. The parameter is required because this repository's development shell exposes Node inside sandbox, not on the host PATH. The harness runs on the host and does not invoke sandbox or a package manager.

The audited import graph consists of `scripts/background-test.ts`, `scripts/lib/log.ts`, `extensions/shared/validation.ts`, and the `fast.ts`, `flood.ts`, `worker.ts`, `capture.ts`, `launch-context.ts` fixtures with their local `log.ts` helper. All use only Node built-ins or dependency-free local modules. No Vitest, Zod, Pi SDK, Bun runner, or sandbox wrapper is loaded. `lifecycle.ts` imports external packages and is excluded from this harness.

`scripts/background-test.ts` uses Node built-ins and local validation/logging helpers. It executes the dependency-free `fast.ts` fixture with the same native Node executable, then tests an unwrapped Bash workload ignoring HUP/TERM/INT. It checks output/exit status, verifies launch process-group ownership, confirms that pane removal alone is insufficient, and escalates only that owned group.

A second run injects an error after resistant-worker launch. A third injects failure while the gated worker and collector are active. Teardown confirms recorded groups, collector/detached-child PIDs, and both private server PIDs have exited before removing the private directory. A separate private control server remains alive during owned-job cleanup. The script is outside Vitest discovery and is not part of `just test`.

The permanent harness additionally verifies:

- FIFO-gated `pipe-pane` capture of fast startup/final output and exit 3.
- A 256 KiB flood completing with a 4096-byte rolling log, eviction offsets, independent reads, collector completion/exit, and 0700/0600 permissions. With its collector stopped before launch, the producer remains live after 300 ms with no captured output; resuming the collector allows completion within five seconds. This demonstrates backpressure for this fixture, not a measured universal tmux memory bound.
- Shell quoting and tmux format escaping with apostrophe, percent, and Unicode characters in private paths.
- Literal shell/key-looking text, Enter, handled Ctrl-C, fixture-specific Ctrl-D exit, and final output/exit 7.
- Actual Linux util-linux `script` PTY attachment, targeted detach, and subsequent worker input.
- Explicit cwd, retained server test-marker environment with `new-session -E`, and explicit session environment override. No unrelated environment values are inspected or printed.
- Normal attached-child exit on pane removal; resistant owned-group escalation; deliberately detached child survival and explicit test-owned cleanup.
- Interactive Bash job control creating a distinct foreground process group in the same pane session. Its resistant worker survives both pane removal and launch-group escalation; validating the foreground group against the pane session and explicitly escalating that group removes it.
- Collector write failure reported without stopping a responsive workload.

The attachment harness explicitly selects Bash for util-linux `script`; inheriting the host Nushell caused a parse error during development. Attachment promises are observed immediately so a rejected client cannot bypass fixture teardown. This does not establish Pi lifecycle or macOS support.

## Automated fixture tests

```bash
sandbox pnpm exec vitest run tests/background-fixtures.test.ts
```

These tests execute native Node subprocesses for fast exit, resistant signals, literal input, bounded rolling capture, permissions, and write errors. They do not execute tmux or establish Pi integration correctness.

## Host tmux setup

Run from the repository root. Use a newly generated private directory, never the default tmux socket.

```bash
root=$(pwd)
probe=$(mktemp --directory /tmp/pi-background-p1.XXXXXXXX)
shell=$(command -v bash)
tmux -f /dev/null -S "$probe/owned.sock" new-session -d -s anchor -c "$root" sleep 300
tmux -f /dev/null -S "$probe/control.sock" new-session -d -s unrelated -c "$root" sleep 300
tmux -f /dev/null -S "$probe/owned.sock" set-option -g remain-on-exit on
tmux -f /dev/null -S "$probe/owned.sock" set-option -g update-environment ''
mkfifo --mode=600 "$probe/start.gate"
```

The anchor keeps the prototype server alive while terminal panes are inspected. Production should use lazy server ownership, not a sleeping anchor process.

## Race-free capture

A constant shell gate waits for the host to install `pipe-pane`. It executes the supplied argv only after release. The gate belongs to the launch adapter, not the sandbox wrapper.

```bash
tmux -f /dev/null -S "$probe/owned.sock" new-session -d -E -s job -c "$root" "$shell" --noprofile --norc -c 'IFS= read -r launch < "$1"; shift; exec "$@"' background-gate "$probe/start.gate" sandbox node "$root/tests/fixtures/background/flood.ts"
tmux -f /dev/null -S "$probe/owned.sock" pipe-pane -O -t job "cd '$root' && exec sandbox node tests/fixtures/background/capture.ts '$probe/output.log' '$probe/capture.json' 4096"
printf 'start\n' > "$probe/start.gate"
tmux -f /dev/null -S "$probe/owned.sock" display-message -p -t job '#{pane_dead}:#{pane_dead_status}:#{pane_pipe}'
stat --format='%a %s' "$probe/output.log"
rg --fixed-strings flood-final "$probe/output.log"
```

The 256 KiB producer must exit with status 0. Capture retains the most recent 4096 raw bytes, reports evicted byte offsets, and creates 0600 files. The separate Vitest test verifies metadata contents and independent reads.

`remain-on-exit` keeps the capture pipe open even after the command exits. Record the pane status, remove the owned session, then wait for the collector's `finished: true` metadata. The final marker must already be captured before removal.

```bash
tmux -f /dev/null -S "$probe/owned.sock" kill-session -t job
rg --fixed-strings '"finished":true' "$probe/capture.json"
```

The same launch sequence supports `fast.ts` (exit 3), `worker.ts OUTPUT_PATH` (interactive; `exit` produces a final marker and exit 7), and trusted unwrapped commands such as `printf`. Recreate the FIFO only after removing the previous one, or reuse it after its previous reader has exited.

`pipe-pane` format-expands its command string, including percent substitutions. The paths in these examples are controlled probe paths. Production must test format escaping separately from shell quoting; caller command text should be passed through the launch argv, never through the capture command.

## Input, attachment, and cleanup

For a launched `worker.ts`, send text with `send-keys -l`, then send `Enter` separately. Inspect the fixture's private event file for its JSON-encoded input marker. Key names embedded in text must stay literal.

Attach using the returned private socket and job session. Detach with the normal tmux prefix followed by `d`, or a targeted `detach-client -s job` from another host client. Check that the worker PID remains alive and subsequent input still works. The Linux probe used util-linux `script` to provide an actual client PTY; its input may include harness-generated NUL bytes, so literal-input assertions are separate from attachment assertions.

For `stubborn.ts`, read its test-owned PID marker. Direct SIGTERM and SIGINT are ignored, but killing its owned session must remove the worker. A wrapper may react differently to terminal Ctrl-C than the inner worker; observe pane exit status/signal rather than assuming the worker handled it.

The host probe also tested trusted `sleep` workers with an attached shell parent. Removing the owned session removed the attached child. An unwrapped Bash command ignoring HUP, TERM, and INT survived pane removal together with its `sleep` child. The known pane PID was verified as its process-group/session leader before removal; SIGKILL to that exact owned launch group removed both processes. Production therefore needs this small targeted escalation, not tmux-only cleanup or a general descendant supervisor.

A deliberate `setsid sleep` child survived pane removal, confirming that detached descendants are outside the guarantee; that exact test-owned child was explicitly terminated afterward. The sandboxed `retained-parent.ts` child disappeared on parent exit, which is wrapper behavior, not proof of generic tmux containment.

Inject a nonexistent log directory into `capture.ts` while keeping a valid metadata path. The collector must record its error without stopping a healthy worker; subsequent input must still reach that worker.

## Isolated Pi lifecycle

Use a private agent directory and explicit fixture extension. No model requests are needed.

```bash
mkdir --mode=700 "$probe/pi-agent"
tmux -f /dev/null -S "$probe/owned.sock" new-session -d -s pi-probe -c "$root" env PI_CODING_AGENT_DIR="$probe/pi-agent" PI_TELEMETRY=0 sandbox pnpm exec pi --offline --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --extension "$root/tests/fixtures/background/lifecycle.ts" --background-probe-output "$probe/lifecycle.events"
tmux -f /dev/null -S "$probe/owned.sock" send-keys -l -t pi-probe -- /new
tmux -f /dev/null -S "$probe/owned.sock" send-keys -t pi-probe Enter
```

Wait for the lifecycle file's `start/new` marker before sending `/reload`, and wait for `start/reload` before sending `/background-probe-quit`. The fixture records event reasons and a process-wide UUID. The UUID must stay unchanged through replacement/reload; graceful exit must record `shutdown/quit` and pane status 0.

Custom flag values are unavailable during extension factory registration in the observed CLI startup. Resolve and validate the required flag from `session_start` or an action handler, not at factory time.

## Teardown

Always remove both test-owned servers, including after a failed probe. Detached-child probes also require explicit cleanup of their recorded test-owned child; killing tmux alone is insufficient.

```bash
tmux -f /dev/null -S "$probe/owned.sock" kill-server
tmux -f /dev/null -S "$probe/control.sock" has-session -t unrelated
tmux -f /dev/null -S "$probe/control.sock" kill-server
pgrep --full "$probe"
rm --recursive "$probe"
```

`pgrep` must find no remaining probe processes. If a server has already exited, distinguish that expected absence from other teardown errors rather than hiding failures.

## Phase 1 review contract

These are selected v1 policies for production review, not a claim that the prototype implements a production manager.

### Actions and results

All action objects reject unknown properties. Every listed field is required; no omitted limit or configuration silently selects a default.

| Action | Fields |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| `start` | `action: "start"`, `name: string` (1–80 characters), `command: string` (1–16384 UTF-8 bytes) |
| `list` | `action: "list"` |
| `logs` | `action: "logs"`, `id: string`, `cursor: number` (nonnegative safe byte offset), `maxBytes: number` (1–65536), `maxLines: number` (1–500) |
| `input` | `action: "input"`, `id: string`, `input: { kind: "text", text: string }` (1–4096 UTF-8 bytes) or `{ kind: "key", key: "Enter"             | "C-c" | "C-d" }` |
| `stop` | `action: "stop"`, `id: string` |

Text is literal and does not imply Enter; Ctrl-D is a PTY key, not a promise of arbitrary stream EOF. The fixture exits on an empty canonical line; other programs may handle it differently.

Success results are `{ ok: true, action, value }`; operational failures are `{ ok: false, action, error: { code, message, id: string | null } }`, also logged through the extension logger. Error codes distinguish `unknown_job`, `terminal_job`, `capacity`, `launch`, `control`, `capture`, `cleanup`, `expired_logs`, and `invalid_cursor`. Validation rejects malformed tool input before operations.

A job snapshot contains `id` (opaque generated UUID), `name`, `command`, `cwd`, `state`, `logPath` (string or null when expired), `attachCommand`, and `exit`. States are `running`, `stopping`, `completed`, `failed`, `stopped`, and `cleanup_failed`; the last remains counted/live until cleanup is confirmed. Exit is a discriminated record: `running`, `code` with numeric `code`, `signal` with a reported `signal`, or `unknown`; never infer workload exit from an absent pane alone.

- Start/stop/input return the job snapshot. Start acknowledges ownership, not readiness.
- List returns `{ jobs: JobSnapshot[] }` in creation order.
- Logs returns `{ job, text, nextCursor, availableFrom, availableTo, gapBytes, truncated, captureState, rawTerminal: true, encodingErrors }`. Capture state is `open`, `finished`, `failed`, or `expired`; failures are not empty successful reads.
- Independent byte cursors start at 0. An evicted cursor advances to the first retained complete UTF-8 boundary and reports skipped bytes. A cursor beyond `availableTo` fails. Reads end at complete UTF-8 boundaries and obey both caller limits; malformed source bytes use replacement characters with `encodingErrors: true`.
- Terminal logs retain ANSI/control sequences; redraws are not pristine application log lines or separate stdout/stderr streams.

### Execution and ownership

Require an explicit absolute Bash executable via extension configuration (`--background-shell`); validate it at runtime startup, never fall back to Pi Bash settings or another shell. Invoke it with `--noprofile --norc -c COMMAND`, passed as argv. The dependency-free host harness currently resolves trusted Bash from PATH and supplies its launch argv explicitly; production configuration is separate.

Use a private socket and `/dev/null` tmux config. Each job has one owned session; use a FIFO launch gate until persistent capture is installed. Use `new-session -E`, disable `update-environment`, and pass current execution cwd explicitly. Jobs inherit the private server's initial runtime environment snapshot; later tmux clients do not refresh it. Session-specific test-marker overrides were proven, but an arbitrary environment override is not part of the tool schema. Never inspect or print inherited environment values.

Verify the pane PID is the owned launch process-group/session leader before acknowledging launch. Graceful stop sends terminal Ctrl-C to the attached workload. Snapshot the terminal's current foreground group before that request and immediately before pane removal; accept a group only when its leader and session ID match the known pane session. After the graceful deadline, remove the owned session and escalate only those verified foreground groups and the launch group if still alive. Never enumerate arbitrary descendants or accept a caller-supplied PID. Interactive job control requires this foreground-group check: launch-group escalation alone is insufficient even though the workload has not detached. Commands must stay attached; daemonized/`setsid` descendants are outside ownership. Failure teardown must attempt every known resource even when another cleanup fails. A failed cleanup remains visible.

The manual attach command names only the returned private socket/session. Detach leaves the job running. Graceful Pi quit removes owned jobs/server; conversation replacement preserves them. Crash recovery is not provided: after SIGKILL, returned attachment information is the manual intervention path.

### Limits and deadlines

| Policy                     | Selected v1 value                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Live jobs                  | 8; reject new launches at capacity                                                                                                         |
| Retained log               | 1 MiB rolling bytes per job; discard oldest, report byte gaps                                                                              |
| Aggregate retained payload | 8 MiB across active/terminal logs; reclaim oldest terminal logs before new launches, never stop live jobs to reclaim history               |
| Terminal metadata          | At most 32 records, expire 15 minutes after terminal transition; oldest terminal metadata evicted first                                    |
| Transient log storage      | At most one additional 1 MiB replacement file per collector; 16 MiB total payload including replacements, with at most 8 active collectors |
| Capture metadata           | At most 4 KiB per retained log, at most 32 entries; 17 MiB total log-directory file-content budget including replacements/metadata         |
| Tmux history               | 1000 lines; diagnostic screen only, never the persistent log source                                                                        |
| Status polling             | 250 ms while jobs exist; no OS queries in footer rendering                                                                                 |
| Launch/control command     | 5-second timeout; no unbounded subprocess output (64 KiB diagnostic bound)                                                                 |
| Stop                       | 2-second graceful interval, then pane removal/verified-group escalation with a 3-second confirmation deadline                              |
| Collector drain            | 2 seconds after pane removal; error and targeted collector teardown if drain fails                                                         |
| Directory/files            | 0700/0600, job IDs generated internally, no caller-supplied tmux targets or log paths                                                      |

Aggregate budgeting includes active captures before acknowledging launch; an expired terminal log returns `expired_logs`, not empty text. Production tests must enforce the metadata and total directory budgets as well as payload bounds. Capacity/write failure must mark capture failed and release the pipe without killing an otherwise healthy workload. The observed stopped collector backpressures its attached producer; v1 does not promise that a stalled filesystem leaves producers unaffected.

### Feasibility findings

The tmux approach is feasible on the observed Linux/tmux 3.7c/Node 24.14.1 stack with a launch gate, separate bounded collector, and small verified launch/foreground-group escalation. Tmux-only pane deletion does not provide the cleanup contract. No sandbox-specific behavior or general descendant supervisor is needed for the documented attached-job boundary.

Production tests must still establish transactional log publication/cursors, UTF-8 boundaries, aggregate/temporary-file accounting, drain deadlines, launch cancellation/concurrency, foreground-group handoff during the stop interval, and real background-job Pi lifecycle behavior. The prototype collector rewrites a bounded file per chunk; it must not be copied as a transactional production reader. A stalled collector test establishes local backpressure, not exact tmux buffer memory limits or every filesystem failure mode. Linux attachment uses util-linux `script`; a macOS harness needs its native PTY invocation and remains unverified. Do not advertise macOS support as passing.

Phase 1 review must approve these findings before production registration. No built-in Bash or installed Pi files were changed.

## Evidence limits

Observed on Linux with tmux 3.7c, Node 24, and Pi 0.85.1. macOS remains unverified. The rolling collector is a feasibility prototype: it rewrites a bounded file per chunk and is not a transactional cursor reader. Slow-disk backlog, capture deadlines, UTF-8-safe cursor decoding, aggregate limits, and lifecycle control of real background jobs still need production tests.
