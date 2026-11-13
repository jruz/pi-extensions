# Pi Extensions

Global Pi extensions, loaded explicitly from `~/dev/projects/agent-config/pi/settings.json`.

- Keep `agent-hooks.ts` before `context-handoff.ts` in the configured loading order.
- `pi-debug` adds `chat-preview.ts` to normal startup.
- `pi-no-hooks` loads only `status-line.ts`, excluding built-in extensions.
- Shell aliases live in the dotfiles repository's Nushell and Zsh alias files.

## Layout

- `extensions/` — extensions loaded by Pi
- `tests/` — integration tests and fixtures
- `docs/` — design notes and Mermaid diagrams
- `specs/` — feature requirements
- `scripts/` — repository scripts
- `~/.local/state/pi/log/` — extension logs
- `~/.pi/agent/agent-config-hooks` — shared hooks used by `extensions/agent-hooks.ts`

## Runtimes

- Extensions and their tests run on Node 24 with Vitest.
- Scripts run on Bun.
- pnpm is the only package manager.

## Subprocesses

- Use `lib/subprocess.ts` for subprocesses launched by extensions.
- Consume piped output concurrently with execution.
- Preserve diagnostics in failure results or logs inside the Pi TUI.
- Forward diagnostics to stderr only outside the Pi TUI.
- Keep stdout reserved for protocol output.
- `no-restricted-imports` enforces the extension boundary in `.oxlintrc.json`.
- Regression coverage lives in `tests/subprocess.test.ts`.

## Status-line verification

Visually verify changes to `extensions/status-line.ts` with Pi in tmux:

```bash
tmux new-session -d -s pi-check -c /tmp/test-project 'pi --no-session --offline --no-tools --extension /path/to/status-line.ts'
sleep 2
tmux capture-pane -p -t pi-check
tmux kill-session -t pi-check
```

Check the captured footer, not only unit tests.

## Recipes

- `just setup` — install dependencies
- `just check` — run checks and tests
- `just fix` — format and fix files
- `just test` — run tests
