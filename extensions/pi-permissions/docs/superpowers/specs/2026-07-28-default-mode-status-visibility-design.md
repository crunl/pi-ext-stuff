# Default Mode Status Visibility Design

## Goal

Keep `pi-permissions` as the source of truth for the active permission mode,
while hiding the ordinary `Default` label from the statusline editor border.
Non-default modes such as `Auto` remain visible.

The existing working-state transition semantics must remain unchanged:

- A mode change requested while the agent is working updates `pendingMode`
  without changing `activeMode`.
- An active Auto review is not cancelled by a queued transition.
- The queued transition is applied only after `agent_settled` and only when no
  approval is active.
- Repeating the cycle shortcut while working can cancel the queued transition.
- An immediate idle transition invalidates approvals from the old permission
  context.

## Design

`pi-permissions` will continue publishing its complete state through:

```ts
ctx.ui.setStatus("pi-permissions", "Default" | "Auto");
```

This preserves the public status contract for other extensions and future UI
consumers.

The `statusline` extension will own the presentation rule. When it partitions
extension statuses, it will:

1. Remove `pi-permissions` from the ordinary footer status list as it does
   today.
2. Normalize the exact `Default` value to `undefined` before updating
   `PermissionsModeState`.
3. Preserve any non-default value, including `Auto`, for the editor border.

Expected rendering:

| Permission status | Bottom editor border |
| --- | --- |
| `Default` | `── (tuzi) gpt-5.6-sol-fast • xhigh ──` |
| `Auto` | `── Auto•(tuzi) gpt-5.6-sol-fast•xhigh ──` |

The normalization belongs in the statusline status adapter rather than in
`pi-permissions` or the editor renderer. This keeps permission state truthful
and keeps the editor renderer independent of permission-mode names.

## Testing

### Statusline

- A `Default` permission status produces no editor-border mode.
- An `Auto` permission status remains visible.
- `pi-permissions` remains excluded from the ordinary footer status list.
- Mode-state render invalidation still occurs only when the normalized visible
  value changes.

### pi-permissions

Retain the existing integration coverage for:

- Default to Auto queued while working.
- Auto to Default queued while an Auto review is active.
- A queued transition not cancelling an active reviewer.
- A second working cycle cancelling the pending transition.
- Applying pending state only after settlement.

Add only a missing assertion or test if the current coverage does not directly
prove both transition directions.

## Scope

No changes will be made to permission evaluation, sandboxing, reviewer
behavior, approval grants, persistence format, shortcuts, or command names.
