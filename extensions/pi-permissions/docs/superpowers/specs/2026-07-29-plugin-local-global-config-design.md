# Plugin-Local Global Configuration Design

## Goal

Move the `pi-permissions` global configuration entry point from:

```text
~/.pi/agent/permissions.json
```

to:

```text
~/.pi/agent/extensions/pi-permissions/config.json
```

Keep trusted project configuration at:

```text
<project>/.pi/permissions.json
```

## Configuration Precedence

Configuration is resolved in this order:

1. Built-in defaults.
2. Plugin-local global `config.json`.
3. Trusted project `.pi/permissions.json`, subject to the existing
   non-escalation restrictions.

The old `~/.pi/agent/permissions.json` path is no longer read. This avoids two
global sources of truth and makes the migration behavior deterministic.

## Path Resolution

`registerExtension` already resolves `agentDir`, whose default is
`~/.pi/agent`. It will pass the plugin configuration path to the configuration
loader:

```text
<agentDir>/extensions/pi-permissions/config.json
```

Tests may continue supplying a temporary `agentDir`; their global fixtures
will be written below the corresponding temporary plugin directory.

## Repository Hygiene

The plugin repository will contain:

- `.gitignore` entry for `/config.json`.
- A tracked `config.example.json` showing every supported field and safe
  defaults.

The real `config.json` remains machine-local and untracked. No automatic copy
or migration from the old path will occur.

## Error Handling

Malformed JSON, unknown fields, or invalid values in `config.json` continue to
raise `ConfigError` with the exact file path. Activation remains fail-closed.

## Testing

- Verify the loader reads `<agentDir>/extensions/pi-permissions/config.json`.
- Verify the old `<agentDir>/permissions.json` is ignored.
- Update all global configuration fixtures to use the new path.
- Retain all project restriction and merge tests.
- Verify `config.json` is ignored and `config.example.json` is valid under the
  current configuration schema.

## Scope

No configuration fields, merge semantics, sandbox behavior, permission rules,
reviewer behavior, project trust requirements, or mode behavior will change.
