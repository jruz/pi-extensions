# Codex account swap

## Overview

Account swapping replaces the active Codex credentials without changing the conversation or model namespace. Account status follows the [status-line failure conventions](status-line.md).

## Account names

THE extension SHALL derive account names from the keys inside `auth.json`'s `codex-account-swap` object.

THE extension SHALL accept exactly two configured accounts.

THE extension SHALL treat `account-1` and `account-2` as example names rather than required names.

THE command completion SHALL suggest the configured account names.

THE account status SHALL display the configured name matching the active account ID.

IF the saved accounts identify the same account ID, THEN THE extension SHALL reject the configuration clearly.

IF the active login matches neither saved account, THEN THE extension SHALL reject the configuration clearly.

## Swapping

WHEN the toggle command runs while idle, THE extension SHALL select the other configured account.

WHEN a configured name is supplied while idle, THE extension SHALL select that account.

WHEN a swap begins, THE extension SHALL preserve the latest active credentials in the matching named entry before replacing them.

THE swap SHALL preserve unrelated auth-file entries.

THE swap SHALL preserve the conversation history.

THE swap SHALL preserve the selected model.

WHEN a swap succeeds, THE footer SHALL invalidate the previous quota reading.

## Failure reporting

IF account-status reading fails, THEN THE extension SHALL expose `err` to the footer.

WHEN account-status reading fails, THE extension SHALL log the operation as `read`.

WHEN credential swapping fails, THE extension SHALL log the operation as `swap`.

THE account failure log SHALL include the project directory.

## References

- [User documentation](../../docs/codex-account-swap.md)
- [Implementation](../../extensions/codex-account-swap.ts)
- [Storage](../../extensions/codex-account-swap/storage.ts)
- [Tests](../../tests/codex-account-swap.test.ts)
