# Codex account swap

Implementation: [`extensions/codex-account-swap.ts`](../extensions/codex-account-swap.ts).

## Credentials

In `~/.pi/agent/auth.json`:

- `codex-account-swap` holds two named entries, for example `account-1` and `account-2`.
- Each named value is a complete OAuth credential object.
- `openai-codex` remains the active login Pi uses.

Keep `type`, `access`, `refresh`, `expires`, and `accountId` in each named entry. Preserve any additional fields. The two entries must identify different accounts. The active login must match one of them. See the [storage schema](../extensions/codex-account-swap/storage.ts).

Names come from the configured keys. No `name` field is needed inside the credential objects.

## Commands

- `/codex-account-swap` toggles accounts.
- `/codex-account-swap account-1` selects the first account.
- `/codex-account-swap account-2` selects the second account.

Switch while idle. After a usage-limit error, swap accounts and type `continue`.

The swap saves the active account's latest credentials to its named entry before replacing `openai-codex`. Updates use Pi's auth-file lock and a private atomic replacement. Other provider entries stay untouched. Pi detects the changed file on its next request.

Model names and conversation history stay unchanged. All Pi processes using this auth file share the active login. Stop other running turns before swapping.

The [status line](../extensions/status-line.ts) displays the active account and invalidates its quota reading after a swap. Account read failures show red `err` and are logged to `~/.local/state/pi/log/pi-extensions.log` with the project and operation.
