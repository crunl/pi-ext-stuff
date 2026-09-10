# SRT 0.0.74 network-mode draft — corrected verification gate

The pinned patch is integrated through pnpm: SRT remains 0.0.74 and Pi 0.85.1.
Default installed-package tests and the bounded macOS installed native gate passed.
DNS/Internet, TLS-handshake and Engine integration acceptance remain open.
The package patch and `NETWORK_MODES.md` retain the original narrow scope: public
optional proxy/restricted/direct, capability detection, initialized health,
macOS native arguments and unchanged filesystem compiler. Workspace/lock changes
only register the patch; no Pi production policy, deployed configuration or Guardian
change is included. Full Goal remains open.

## Accepted corrections

- Optional undefined inherits the selected mode and effective credentials/options;
  null/unknown mode rejects. Validation and rendering no longer disagree.
- These durable programs are canonical. `provenance.json` inventories their current
  bytes and the entire pinned patched package. Old scratch programs/hashes and the
  timeout report are historical evidence, not the current execution command.
- Forced SIGKILL is containment, **not** successful finally/reset. Native lifecycle
  tests separately await cooperative host cancellation and reset, observe child,
  worker and process-group disappearance, and independently reconnect to closed
  loopback listeners. Interruption/output/deadline failure never counts as a pass.
- Explicit `/opt/homebrew/bin/biome` 2.5.10 is available; formatting/import/template
  corrections precede fresh hashing/copying. The old availability claim was wrong.

## Reproduce without hard-coded checkout/package paths

Run from this repository with existing Node/dependencies. Choose a fresh absolute
output directory beneath an existing writable parent; it must not already contain
unowned output. Use a short path (under about 65 bytes) for macOS Unix sockets.
An owned marker binds UID, checkout and patch hash. Symlink/ownership/hash/version
mismatches fail closed. Deletion is confined to the owned isolated package and
fresh per-run fixtures only when process disappearance and clean worker exits are
proven. Failed/unproven cleanup retains fixtures. Do not delete prior evidence.

**Pristine source:** `prepare.mjs --package isolated` copies the **unpatched**
pnpm store package
`node_modules/.pnpm/@anthropic-ai+sandbox-runtime@0.0.74/node_modules/@anthropic-ai/sandbox-runtime`,
then applies `patches/anthropic-ai__sandbox-runtime@0.0.74.patch` once. The
project's `node_modules/@anthropic-ai/sandbox-runtime` link is the **patched**
snapshot and is never used as prepare input.

Plain commands (replace `$ROOT` with a fresh owned absolute directory):

```sh
node patches/srt-network-mode/prepare.mjs --root "$ROOT" --package isolated
node patches/srt-network-mode/verify.mjs --root "$ROOT" --package isolated
SRT_NETWORK_MODE_PACKAGE="$ROOT/package" node node_modules/vitest/vitest.mjs run tests/srt-network-mode-patch.test.ts
SRT_NETWORK_MODE_PACKAGE="$ROOT/package" node node_modules/vitest/vitest.mjs run
npm run check
npm run lint
```

Historical c1/c4/c5/c6 session roots and `rtk run` wrappers are **not** part of
the supported procedure; keep them only as past evidence.

The c1 attempt failed before any positive/case result (ECONNRESET followed
by cleanup EPERM); its log, copies and c1/nm-qbUqUK are historical failed evidence.
Separate parent signal controls passed for live and orphan-leader groups; they do
not identify c1's EPERM cause, nor establish SRT as that cause.
The later c4 run passed both positive controls and the basic restricted/proxy/direct,
filesystem/Git and prewrapped-descriptor cases, then failed the partial-initialization
fault's expected errno. A separate no-SRT macOS/Node 26.5.0 control observed positive
Unix binding, missing-parent lstat=ENOENT and binding=EACCES. The corrected fault
assertion requires EACCES, syscall=listen and the precise owned mux-socket address;
ordinary native-negative assertions are unchanged. The corrected c5 run exited zero:
CA/agent suppression and inheritance, partial-init reset/fresh-init, both workers and
cooperative cancellation/reaping/reset passed; its temporary fixtures were removed.
The c1 and c4 failures and fixtures remain preserved. The c5 oracle correction was
parent-reviewed against the independent no-SRT control, not independently pre-reviewed;
the complete bounded result subsequently passed independent post-run review.
A subsequent npm test launch exposed duplicate loading when both npm config paths
were `/dev/null` (tests did not start). c6 uses two distinct paths inside each fresh
owned fixture; offline/no-update remain set. Its complete local native gate, 863-test
suite (one skipped), six static regressions and type checks passed. No source patch
or native permission assertion changed for this environment correction.

Preparation uses only pristine installed bytes and their existing dependency
links, `/usr/bin/patch`, hashes and file copies; no SRT initialization or sockets.
Verification is also static unless the **explicit** `--run-native` flag is present.
Canonical and copied programs are verified before execution. After a fresh checkout
or scratch cleanup, repeat preparation with a fresh root. After installation use
`verify.mjs --root <fresh-root> --package installed`: this reconstructs canonical
program copies and verifies the installed patched package without modifying it.
Identity mismatches name every diverging path and expected/actual digest. A
digest-only mismatch on patched documentation usually means a **double-applied**
hunk; reinstall from the lockfile (or re-apply once). A missing patched file means
a **lost** patch — do not treat the two the same way.
No executable bytes, package paths, network targets or policy must be edited.
Only the two package selections are accepted; no arbitrary package/target option.
Package inventory rejects every nested node_modules entry and rejects root
node_modules by default. Isolated verification still requires its exact owned
root dependency symlink. Installed verification additionally permits absence
(pnpm 11) or exactly owned mode-0755 `node_modules/.bin/srt` with owned mode-0755
containers, no symlinks and no extra entries (including `node`/`node.exe`). The
entire shim must match `pnpm-12.3.4-self-bin.sh.txt`, pinned in provenance and copied
with the verifier. Only NODE_PATH and absolute cmd-shim-target fields are computed
from the real pinned 0.0.74 patch snapshot in the observed `.pnpm` layout. Unsupported
layout/version/patch or shell-escaping path shapes fail closed; the shim is never
executed or rewritten. Only those fully validated generated containers/leaf are
excluded; complete upstream packageFiles equality remains required.

For a **read-only pre-promotion inventory**, resolve the staged package to its real
path and call the same public helper used by installed `verifyPackage`:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import { inventory } from "./patches/srt-network-mode/artifacts.mjs";
const provenance = JSON.parse(fs.readFileSync("patches/srt-network-mode/provenance.json"));
const packagePath = fs.realpathSync(process.env.SRT_INVENTORY_PACKAGE);
assert.deepEqual(inventory(packagePath, undefined, { installed: true }), provenance.packageFiles);
```

This inventory option is not a new CLI package selector and does not claim project
installation or native acceptance by itself. The staged pnpm@12.3.4 inventory matched
provenance before promotion. The subsequent project installation reused one package,
downloaded none, preserved dependency versions and passed installed verification.
Default tests reported 863 passed/one skipped; repository types and the unchanged
public consumer passed, as did the fresh `i2` installed native gate. No reload ran.

For the installed **compile-only** consumer, the owned verification root needs both
`package` pointing to the verified public package and `node_modules` pointing to its
exact real sibling dependency directory. Copy the unchanged type template to `.mts`.
The first attempt with only `package` could not resolve `zod` through TypeScript's
lexical symlink path and correctly failed an `@ts-expect-error` check. Adding the
owned dependency link resolved zod 3.25.76 and preserved both negative assertions;
no declaration or executable was changed. `skipLibCheck` remains an upstream-type
limitation, not a reason to remove those assertions. Use a separate fresh native root.
Static regression command (no shim or package fixture bytes are imported/executed):

```sh
SRT_ARTIFACT_TEST_ROOT="$(mktemp -d /tmp/srt-art.XXXXXX)" node --test patches/srt-network-mode/artifacts-static-check.mjs
```

Connectivity-only TCP/Unix sentinels now send no payload, count expected peer
ECONNRESET closes separately, and fail on other socket/server errors. Accepted-
connection counts and native-negative EPERM/EACCES requirements are unchanged.

Public type checking retains the repository's existing `skipLibCheck` policy:
unchanged upstream declarations reference missing `@types/node-forge`. No ambient
stub, dependency installation or TLS-disable setting is added. Before integration,
default tests intentionally reject pristine SRT; override only the new API test's
package path for this draft. Existing adapter tests use their own fake backend,
not patched SRT simply because the environment override is present.

## Parent-only native gate (never execute in the writer)

After fresh independent review, through the separately approved macOS boundary
**outside** the outer tool Seatbelt sandbox, run exactly:

```sh
node patches/srt-network-mode/verify.mjs --root <fresh-owned-root> --package installed --run-native
```

This requires reviewed pnpm integration and actual project installation first.
Do not reuse the historical c6 root or its program copies. The launcher verifies artifacts/package, then the harness
spawns replacement-environment workers; inherited credentials/proxies are not
passed. Local upstream `npm root -g` discovery receives user/global npm config
paths `${root}/npm-user-config` and `${root}/npm-global-config`, offline=true and
update_notifier=false; no real npmrc/log is read by this verification setup. No private inputs, public endpoints, system keychain changes or shell
profile edits. Only synthetic loopback and Unix fixtures are targeted.

Retained cases: TCP4/6/mapped IP, UDP4/6, Unix, actual IP inbound, real SRT proxy
and separate guard, filesystem/Git deny and positive controls before/after,
a prewrapped restricted descriptor A launched after a host update/new direct B,
policy restore/reset and invalid-CA failure. This descriptor test is NOT an
already-running A across a later grant; that remains an Engine/registered-tool gate.
Added cases: healthy inherited absent/undefined mode; effective deny/mask
credentials; undefined sibling conflicts; valid public-generated local CA plus
actual vendored agent file; non-proxy environment and denied-read suppression,
with a proxy positive control. No TLS verification or handshake claim follows
from merely initializing that CA; no Java agent is executed.

Native lifecycle cases include a genuine filesystem failure seam (nonexistent
owned TMPDIR prevents mux Unix-backend bind), awaited reset then fresh successful
initialization; a separate cooperative cancellation worker runs active sandbox
work, receives a parent cancellation request, terminates/reaps that child, calls
cleanup/reset, and reports listeners/PIDs for independent disappearance checks.
The cancellation wait races child closure, rejects recorded exit before signalling,
and uses the owned ChildProcess handle rather than a stale numeric PID. Four static
regressions exercise this same helper with only the external child boundary faked:
`node --test patches/srt-network-mode/cooperative-cancellation-static-check.mjs`.
They do not exercise live PID reuse. No implementation behavior is mocked for the
separate native cases.

Bounds: main worker 60s, cooperative worker 10s, ordinary workloads 6s, socket
operations 0.5–1.5s, output 64KiB per worker/16KiB per workload. Independent self-exit
backstops bound workers at 75s/15s, ordinary workloads at 10s, and the cancellation
child at 8s if external signalling fails. These exits use status 124 and always fail
the gate; they are forced containment, never reset or successful cancellation.
Forced deadline,
interruption or excess output attempts signalling only the still-owned live
worker group; **it cannot execute the killed worker's reset/finally**. A leader
already observed exited is not re-signalled without proving current ownership.
Primary errors survive cleanup; every cleanup error is separately reported with
bounded phase, PID/PGID, UID and error code (no argv/env/credential dump). Each
safe cleanup step is attempted independently with a 2s bound. Signalling failure
is a failed gate, not ignored or a reason to widen OS permissions. Observer handles
are released even if signalling fails. Fixtures are retained whenever signalling,
process disappearance, worker clean exit or cleanup is unproven. Graceful reset is reported
only by completed cooperative/normal paths. Negative enforcement requires
EPERM/EACCES; timeout/ECONNREFUSED is not native-denial proof. ECONNREFUSED is used
only by the separate post-reset listener-disappearance observer.

Native SRT cleanup-failure injection is not attempted: macOS reset has no safe
public injectable close-failure seam, and its existing close errors may be caught.
Existing `tests/srt-enforcer.test.ts` cleanup/restore/reset poison-and-activation
cases exercise Pi against an external fake backend, not native SRT cleanup failure.
They remain distinct evidence; do not infer native failure recovery from them.
The c6 local native gate does not establish system DNS, non-loopback/Internet access,
a TLS handshake, Java execution or Engine authority. Linux/Windows fail-closed tests
simulate platform selection, not real native platform evidence.

## Parent-only integration/removal

After review and native acceptance, use pnpm's version-specific patch mechanism:

```yaml
patchedDependencies:
  '@anthropic-ai/sandbox-runtime@0.0.74': patches/anthropic-ai__sandbox-runtime@0.0.74.patch
```

Retain the original lock/workspace archive. Use an already-verified cached native
pnpm binary (not a bootstrap wrapper), clean HOME/config and `/dev/null` auth;
first `install --offline --ignore-scripts --lockfile-only`, review only pinned
patch metadata/importer/snapshot changes, then `install --offline --ignore-scripts
--frozen-lockfile`. Stop on cache miss, version/integrity/format/unrelated drift;
no online fallback. No such command is authorized or executed in this writer pass.
Then default tests, typecheck and the installed-package native gate must pass.

Maintain/remove this local distribution patch only after an equivalent upstream
public API passes fresh source/native review. Engine/public-tool scope and lifetime,
whole-network authority, actual non-loopback/DNS/TLS behavior, system TLS startup
policy, Guardian/delegation and full end-to-end Goal verification remain later gates.
