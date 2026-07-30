# Core execution abort gate

YOLO mode requires one small patch to Homebrew Pi 0.82.1. The patch adds an
`AbortSignal` check immediately before each prepared tool closure invokes
`tool.execute()`. It also publishes a runtime capability marker consumed by
pi-permissions.

Install and verify:

```sh
npm run core:install
npm run core:check
npm run core:test
```

The installer targets the active `/opt/homebrew/bin/pi`, accepts only
`@earendil-works/pi-agent-core` 0.82.1 with the known original SHA-256, writes
an adjacent `.pi-permissions-0.82.1.orig` backup, and verifies the exact patched
SHA-256. Re-running it is safe. A Pi upgrade or source mismatch is rejected
without modifying the core.

Until the runtime marker is present, pi-permissions refuses to enter YOLO and
continues with the last restrictive mode.

