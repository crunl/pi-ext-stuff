# Unix sockets: SRT allowlist axis (A2)

## Scope

- Date: 2026-09-19
- Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- SRT: pristine `@anthropic-ai/sandbox-runtime@0.0.77` (native `network.allowUnixSockets` / `allowAllUnixSockets`; **no pnpm patch**)
- Host pin: `@earendil-works/pi-coding-agent@0.85.1`
- Supersedes the “unix sockets stay a future axis” claim in `2026-09-12-network-access-whole-open.md` for the **config surface only**. TCP `network_access` semantics are unchanged.

## Decision (A2)

```json
{
  "sandbox": {
    "network": {
      "allowUnixSockets": ["/absolute/path/to.sock"],
      "dangerouslyAllowAllUnixSockets": false
    }
  }
}
```

- Semantic Codex alignment (default deny, `dangerously_*` naming), **not** Codex’s deny-map shape: SRT only projects a path **list** + all-sockets bool.
- Empty/absent/false → **omit** SRT fields (AF_UNIX stays blocked).
- Orthogonal to Engine `network_access` (TCP lease). Lease true never opens sockets.
- Delegation pins child sockets to `[]` / `false`. Guardian worker never injects sockets.
- `request_permissions` cannot grant sockets (B rejected).
- Config load rejects `"/"` and directory prefixes (macOS SRT seatbelt **subpath** match would widen the allowlist).

## Security honesty

- Allowing `~/.orbstack/run/docker.sock` / `/var/run/docker.sock` ≈ host docker-group privilege (SRT README).
- Linux: path lists ignored; seccomp all-or-nothing.
- Socket denials are OS hard-blocks; they do **not** enter LLM review.

## What this note does not claim

- No claim that default is open; default remains deny.
- No claim that Guardian or auto-review can approve a socket path.
- No claim that `network_access:true` includes AF_UNIX.
- Sibling `pi-core` dirty → formal pair acceptance remains provisional.
