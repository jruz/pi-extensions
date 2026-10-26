# Status line

## Overview

The footer displays session status. Failure presentation applies to every module, including account status supplied by another extension.

## Failures

IF a status-line module fails, THEN THE status line SHALL display `err` for that module.

WHILE a module displays `err`, THE status line SHALL render that value using the theme's `error` foreground color.

WHEN a module fails, THE responsible extension SHALL record the diagnostic failure in its extension log.

THE diagnostic log SHALL identify the failed module.

THE diagnostic log SHALL identify the failed operation.

THE diagnostic log SHALL include the failure timestamp.

THE diagnostic log SHALL include the failure message.

WHERE an extension log is shared across projects, THE diagnostic log SHALL identify the project directory.

THE diagnostic log SHALL exclude credential values.

IF diagnostic logging fails, THEN THE responsible extension SHALL report the logging failure visibly.

## Verification

THE status-line tests SHALL verify the error foreground color for failed modules.

THE status-line tests SHALL verify failure logging at the responsible boundary.

WHEN footer presentation changes, THE verification SHALL include capturing Pi's rendered footer in tmux.

## References

- [Implementation](../../extensions/status-line.ts)
- [Lifecycle tests](../../tests/status-line-lifecycle.test.ts)
- [Codex account swap](codex-account-swap.md)
