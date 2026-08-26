import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxManagerLike, SandboxPolicy } from "../sandbox.ts";

/** How long a generated profile file lingers before best-effort pruning. */
const PROFILE_TTL_MS = 60 * 60 * 1000;
let profileSeq = 0;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Render a SandboxPolicy as a nono profile document. Every field maps onto
 * the documented profile schema (filesystem.allow/deny, network.allow_domain/
 * deny_domain). denyRead and denyWrite are unioned into filesystem.deny:
 * nono's profile-level deny blocks both operations, which can only over-
 * restrict relative to srt semantics — the fail-closed direction.
 *
 * Deliberate boundary: nono's built-in system groups grant r+w on /private/tmp
 * (and TMPDIR-adjacent paths) so compilers and package managers can stage temp
 * files without per-call approval. This matches srt parity and is accepted
 * agent-sandbox practice; profile-level `deny` entries can still override it
 * if a policy ever needs to fence off temp storage.
 */
export function buildNonoProfile(policy: SandboxPolicy): object {
  return {
    filesystem: {
      ...(policy.filesystem.allowWrite.length > 0 ? { allow: policy.filesystem.allowWrite } : {}),
      deny: [...new Set([...policy.filesystem.denyRead, ...policy.filesystem.denyWrite])],
    },
    network: {
      ...(policy.network.allowedDomains.length > 0
        ? { allow_domain: policy.network.allowedDomains }
        : {}),
      ...(policy.network.deniedDomains.length > 0
        ? { deny_domain: policy.network.deniedDomains }
        : {}),
    },
  };
}

async function writeProfileFile(policy: SandboxPolicy): Promise<string> {
  const dir = join(tmpdir(), "pi-permissions-nono");
  if (!existsSync(dir)) await mkdtemp(dir);
  profileSeq += 1;
  const file = join(dir, `policy-${Date.now()}-${profileSeq}.json`);
  await writeFile(file, JSON.stringify(buildNonoProfile(policy)));
  void pruneStaleProfiles(dir).catch(() => undefined);
  return file;
}

async function pruneStaleProfiles(dir: string): Promise<void> {
  const cutoff = Date.now() - PROFILE_TTL_MS;
  for (const entry of await readdir(dir)) {
    const match = /^policy-(\d+)-\d+\.json$/.exec(entry);
    if (!match) continue;
    if (Number(match[1]) < cutoff) await unlink(join(dir, entry)).catch(() => undefined);
  }
}

function probeNono(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("nono", ["--version"], { stdio: "ignore" });
    child.once("error", () =>
      reject(
        new Error(
          "pi-permissions sandbox unavailable: the `nono` executable was not found. Install it (brew install nono) or configure a different sandbox manager.",
        ),
      ),
    );
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`pi-permissions sandbox unavailable: nono probe exited with ${code}`));
    });
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
    _abortSignal?: AbortSignal,
  ): Promise<string> {
    await this.ensureProbed();
    const policy = resolvePolicy(this.basePolicy, customConfig);
    const profilePath = await writeProfileFile(policy);
    return `nono run --profile ${shellQuote(profilePath)} -- ${command}`;
  }

  private ensureProbed(): Promise<void> {
    this.probeResult ??= probeNono();
    return this.probeResult;
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
      ...(partial.filesystem?.allowGitConfig !== undefined
        ? { allowGitConfig: partial.filesystem.allowGitConfig }
        : {}),
    },
    network: {
      allowedDomains: partial.network?.allowedDomains ?? [],
      deniedDomains: partial.network?.deniedDomains ?? [],
      ...(partial.network?.httpProxyPort !== undefined
        ? { httpProxyPort: partial.network.httpProxyPort }
        : {}),
      ...(partial.network?.socksProxyPort !== undefined
        ? { socksProxyPort: partial.network.socksProxyPort }
        : {}),
    },
  };
}
