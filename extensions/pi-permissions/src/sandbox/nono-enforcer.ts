import { spawn } from "node:child_process";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxManagerLike, SandboxPolicy } from "../sandbox.ts";
import { filterFeasibleAllowPaths } from "./feasible-allow.ts";

/** How long a generated profile file lingers before best-effort pruning. */
const PROFILE_TTL_MS = 60 * 60 * 1000;
/** Keep sandbox preparation bounded even when the CLI or filesystem stalls. */
export const NONO_PROBE_TIMEOUT_MS = 5_000;
export const PROFILE_PREPARATION_TIMEOUT_MS = 5_000;
let profileSeq = 0;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Render a SandboxPolicy as a nono profile document. SandboxPolicy.network
 * is an allowlist (empty = no egress). nono's default is the opposite, so
 * an empty allowlist becomes network.block; granted hosts become
 * allow_domain and must not also set block (block-net does not start the
 * CONNECT proxy). denyRead and denyWrite are unioned into filesystem.deny.
 *
 * Deliberate boundary: nono's built-in system groups grant r+w on /private/tmp
 * (and TMPDIR-adjacent paths) so compilers and package managers can stage temp
 * files without per-call approval. This matches srt parity and is accepted
 * agent-sandbox practice; profile-level `deny` entries can still override it
 * if a policy ever needs to fence off temp storage.
 */

/**
 * Nono treats colons in deny_domain entries as a port separator. IPv6
 * literals, such as ::1, are therefore incompatible with this profile field.
 * This compatibility filter does not widen allowedDomains: risk evaluation
 * still hard-blocks direct private or special-use network targets.
 */
function filterNonoDeniedDomains(domains: readonly string[]): string[] {
  return domains.filter((domain) => isIP(domain) !== 6);
}

export function buildNonoProfile(policy: SandboxPolicy): object {
  const deniedDomains = filterNonoDeniedDomains(policy.network.deniedDomains);
  const denyDomain = deniedDomains.length > 0 ? { deny_domain: deniedDomains } : {};
  const network =
    policy.network.allowedDomains.length > 0
      ? { allow_domain: policy.network.allowedDomains, ...denyDomain }
      : { block: true };
  const allow = filterFeasibleAllowPaths(policy.filesystem.allowWrite);
  return {
    filesystem: {
      ...(allow.length > 0 ? { allow } : {}),
      deny: [...new Set([...policy.filesystem.denyRead, ...policy.filesystem.denyWrite])],
    },
    network,
  };
}

async function writeProfileFileUnbounded(policy: SandboxPolicy): Promise<string> {
  const dir = join(tmpdir(), "pi-permissions-nono");
  await mkdir(dir, { recursive: true });
  profileSeq += 1;
  const file = join(dir, `policy-${Date.now()}-${profileSeq}.json`);
  await writeFile(file, JSON.stringify(buildNonoProfile(policy)));
  void pruneStaleProfiles(dir).catch(() => undefined);
  return file;
}

function abortedError(): Error {
  return new Error("aborted");
}

function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    // Keep observing the shared operation after this caller stops waiting. This
    // prevents a later probe failure from becoming an unhandled rejection.
    void operation.catch(() => undefined);
    return Promise.reject(abortedError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortedError()));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function runWithDeadline<T>(
  operationFactory: () => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortedError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(timeoutError())), timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortedError()));
    signal?.addEventListener("abort", onAbort, { once: true });

    let operation: Promise<T>;
    try {
      operation = operationFactory();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function writeProfileFile(policy: SandboxPolicy, signal?: AbortSignal): Promise<string> {
  return runWithDeadline(
    () => writeProfileFileUnbounded(policy),
    signal,
    PROFILE_PREPARATION_TIMEOUT_MS,
    () =>
      new Error(
        `pi-permissions sandbox unavailable: profile preparation timed out after ${PROFILE_PREPARATION_TIMEOUT_MS}ms`,
      ),
  );
}

async function pruneStaleProfiles(dir: string): Promise<void> {
  const cutoff = Date.now() - PROFILE_TTL_MS;
  for (const entry of await readdir(dir)) {
    const match = /^policy-(\d+)-\d+\.json$/.exec(entry);
    if (!match) continue;
    if (Number(match[1]) < cutoff) await unlink(join(dir, entry)).catch(() => undefined);
  }
}

const NONO_NOT_FOUND_MESSAGE =
  "pi-permissions sandbox unavailable: the `nono` executable was not found. Install it (brew install nono) or configure a different sandbox manager.";

function probeNono(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      child?.removeListener("error", onError);
      child?.removeListener("close", onClose);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onError = () => finish(() => reject(new Error(NONO_NOT_FOUND_MESSAGE)));
    const onClose = (code: number | null) => {
      if (code === 0) finish(resolvePromise);
      else
        finish(() =>
          reject(new Error(`pi-permissions sandbox unavailable: nono probe exited with ${code}`)),
        );
    };

    try {
      child = spawn("nono", ["--version"], { stdio: "ignore" });
    } catch {
      reject(new Error(NONO_NOT_FOUND_MESSAGE));
      return;
    }

    child.once("error", onError);
    child.once("close", onClose);
    timer = setTimeout(() => {
      if (settled) return;
      const shouldKill = !child.killed;
      finish(() =>
        reject(
          new Error(
            `pi-permissions sandbox unavailable: nono probe timed out after ${NONO_PROBE_TIMEOUT_MS}ms`,
          ),
        ),
      );
      if (shouldKill) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may have exited between the state check and kill.
        }
      }
    }, NONO_PROBE_TIMEOUT_MS);
  });
}

/**
 * SandboxManagerLike implementation backed by the `nono` CLI. State-free by
 * design: every wrapped command carries its complete policy via a generated
 * profile file, so there is nothing to reset between activations and no
 * rollback machinery around a mutable shared sandbox.
 */
export class NonoSandboxManager implements SandboxManagerLike {
  /** Latest initialized base config, used when a caller omits customConfig. */
  private basePolicy: SandboxPolicy | undefined;
  private probeResult: Promise<void> | undefined;

  async initialize(config: SandboxPolicy): Promise<void> {
    this.basePolicy = config;
    await this.ensureProbed();
  }

  async reset(): Promise<void> {
    // Nothing to tear down: policies are per-invocation artifacts.
  }

  async wrapWithSandbox(
    command: string,
    _binShell?: string,
    customConfig?: Partial<SandboxPolicy>,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    await this.ensureProbed(abortSignal);
    const policy = resolvePolicy(this.basePolicy, customConfig);
    const profilePath = await writeProfileFile(policy, abortSignal);
    if (abortSignal?.aborted) throw abortedError();
    return `nono run --silent --profile ${shellQuote(profilePath)} -- /bin/bash -c ${shellQuote(command)}`;
  }

  private ensureProbed(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortedError());
    this.probeResult ??= probeNono();
    return awaitWithAbort(this.probeResult, signal);
  }
}

function resolvePolicy(
  base: SandboxPolicy | undefined,
  override: Partial<SandboxPolicy> | undefined,
): SandboxPolicy {
  if (!base) {
    if (!override || Object.keys(override).length === 0) {
      throw new Error("pi-permissions sandbox unavailable: no policy provided for execution");
    }
    return normalizePartial(override);
  }
  if (!override || Object.keys(override).length === 0) return base;
  return normalizePartial({
    ...base,
    ...override,
    filesystem: { ...base.filesystem, ...override.filesystem },
    network: { ...base.network, ...override.network },
  });
}

function normalizePartial(partial: Partial<SandboxPolicy>): SandboxPolicy {
  return {
    filesystem: {
      allowWrite: partial.filesystem?.allowWrite ?? [],
      denyRead: partial.filesystem?.denyRead ?? [],
      denyWrite: partial.filesystem?.denyWrite ?? [],
      ...(partial.filesystem?.grantableDenyWrite !== undefined
        ? { grantableDenyWrite: partial.filesystem.grantableDenyWrite }
        : {}),
    },
    network: {
      allowedDomains: partial.network?.allowedDomains ?? [],
      deniedDomains: partial.network?.deniedDomains ?? [],
    },
  };
}
