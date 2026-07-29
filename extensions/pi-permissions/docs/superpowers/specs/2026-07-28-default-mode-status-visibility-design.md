# Default Mode Status Visibility Design

## Goal

Keep `pi-permissions` as the source of truth for the active permission mode,
while hiding the ordinary `Default` label from the statusline editor border.
Non-default modes such as `Auto` remain visible.

Working-state transitions follow these semantics:

- A mode change updates the selected mode and status immediately.
- The next tool call uses the newly selected mode without waiting for
  `agent_settled`.
- An active human approval or Auto review completes under its captured mode.
- Commands, Shift+Tab, and approval-panel mode choices are applied in user
  action order.
- Repeating Shift+Tab while working performs each requested cycle in order.

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

- Default to Auto taking effect for the next approval while working.
- Auto to Default leaving the active reviewer intact while routing the next
  approval through Default.
- A later approval-panel choice winning over an earlier delayed Shift+Tab.
- Repeated working cycles being applied in action order.

Add only a missing assertion or test if the current coverage does not directly
prove both transition directions.

## Scope

This revision changes working mode-transition timing and removes persisted
`pendingMode`. It does not change permission evaluation, sandboxing, reviewer
policy, approval scope, shortcuts, or command names.
