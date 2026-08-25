// One-call capability grants minted at decision time (user popup or
// auto-review) and spent once at execution time. Replaces the previous three
// parallel Maps (call approval / network hosts / write roots) so that a grant
// is validated and consumed atomically instead of being burned before its
// execution-time validation runs.

export type GrantAuthority = "user" | "auto-review";

export interface Grant {
  authority: GrantAuthority;
  /** Fingerprint of the permission config the decision was made under. */
  configFingerprint: string;
  /** Resolved cwd at decision time. */
  cwd: string;
  /** Binds the grant to the exact tool name + input payload. */
  requestFingerprint: string;
  /** One-shot network escalation hosts, if any were granted. */
  networkHosts?: string[];
  /** One-shot additional write roots, if any were granted. */
  writeRoots?: string[];
}

export interface GrantMintInput {
  toolCallId: string;
  toolName: string;
  input: unknown;
  authority: GrantAuthority;
  configFingerprint: string;
  /** Already-resolved cwd. */
  cwd: string;
  networkHosts?: readonly string[];
  writeRoots?: readonly string[];
}

export interface GrantVerifyInput {
  tool: string;
  input: Record<string, unknown>;
  /** Resolved current cwd. */
  cwd: string;
  configFingerprint: string;
}

/** Non-secret fingerprint binding a grant to tool + input payload. */
export function grantRequestFingerprint(toolName: string, input: unknown): string {
  return `${toolName.toLowerCase()}:${JSON.stringify(input ?? null)}`;
}

export class GrantLedger {
  private grants = new Map<string, Grant>();

  mint(input: GrantMintInput): void {
    const grant: Grant = {
      authority: input.authority,
      configFingerprint: input.configFingerprint,
      cwd: input.cwd,
      requestFingerprint: grantRequestFingerprint(input.toolName, input.input),
    };
    if (input.networkHosts && input.networkHosts.length > 0) {
      grant.networkHosts = [...input.networkHosts];
    }
    if (input.writeRoots && input.writeRoots.length > 0) {
      grant.writeRoots = [...input.writeRoots];
    }
    this.grants.set(input.toolCallId, grant);
  }

  /** Non-consuming read, e.g. to decide lease exclusivity before execution. */
  peek(toolCallId: string | undefined): Grant | undefined {
    if (!toolCallId) return undefined;
    return this.grants.get(toolCallId);
  }

  /**
   * Pure fingerprint check of a peeked grant against the *current* world.
   * Callers run their async re-validation between verify() and consume(),
   * so a failed validation never burns the grant.
   */
  verify(grant: Grant | undefined, expected: GrantVerifyInput): boolean {
    if (!grant) return false;
    return (
      grant.cwd === expected.cwd &&
      grant.configFingerprint === expected.configFingerprint &&
      grant.requestFingerprint === grantRequestFingerprint(expected.tool, expected.input)
    );
  }

  /** Consume the single-use grant after successful validation. */
  consume(toolCallId: string | undefined): Grant | undefined {
    if (!toolCallId) return undefined;
    const grant = this.grants.get(toolCallId);
    this.grants.delete(toolCallId);
    return grant;
  }

  revoke(toolCallId: string | undefined): void {
    if (!toolCallId) return;
    this.grants.delete(toolCallId);
  }

  clear(): void {
    this.grants.clear();
  }

  /** Whether spending this grant requires an exclusive sandbox lease. */
  needsExclusiveLease(toolCallId: string | undefined): boolean {
    return (this.peek(toolCallId)?.networkHosts?.length ?? 0) > 0;
  }
}
