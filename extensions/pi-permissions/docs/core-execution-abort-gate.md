# Optional core execution abort gate

YOLO mode does not require a core patch. It already follows Pi's native Full
Access behavior: no approval prompt and no pi-permissions sandbox. The optional
patch adds an `AbortSignal` check immediately before each prepared tool closure
invokes `tool.execute()`. It is useful only when a deployment wants an extra
last-moment guard against starting a prepared tool after an abort.

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

The runtime marker is not consulted when entering YOLO. Without the marker,
YOLO remains fully usable; only the additional core-level abort guarantee is
absent. The patch also cannot forcibly stop a tool that has already started.
