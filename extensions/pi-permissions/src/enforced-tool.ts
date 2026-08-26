// Protocol B: validate -> spend -> execute. One implementation for every
// guarded tool; per-tool variance (lease policy, sandboxed substrate) is
// supplied as strategy fragments by the host table. The host object is the
// Step-4 seam: today it adapts register.ts closures, tomorrow it is the
// PermissionSession instance — the skeleton does not change.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { Grant } from "./grant-ledger.ts";

export const ABORTED_TOOL_MESSAGE = "Operation aborted";

/** Semantic slice of the post-activation snapshot the skeleton gates on. */
export interface ActivationFacts {
  privilegeMax: string;
  sandboxEnabled: boolean;
  sandboxReady: boolean;
  baseSandboxConfig: SandboxRuntimeConfig | undefined;
}

/** Host adapter. `Snap` stays opaque here; only the host knows its shape. */
export interface EnforcerHost<Snap> {
  /** Settle pending config/mode mutations, then read the turn snapshot. */
  activate(ctx: ExtensionContext): Promise<ActivationFacts & { raw: Snap }>;
  /** TOCTOU re-validation; consumes the single-use grant on any attempt. */
  authorize(
    tool: string,
    id: string,
    input: Record<string, unknown>,
    ctx: Pick<ExtensionContext, "cwd">,
    snap: Snap,
  ): Promise<Grant | undefined>;
  peekGrant(id: string | undefined): Grant | undefined;
  revokeGrant(id: string | undefined): void;
  coordinate<T>(
    lease: "exclusive" | "shared",
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T>;
  sandboxUnavailableReason(): string;
}

/** Everything a leased substrate body may touch. */
export interface LeasedInvocation<P, OU> {
  id: string;
  params: P;
  signal: AbortSignal | undefined;
  onUpdate: OU;
  /** Full host context; substrates may surface UI (e.g. sandbox restore failures). */
  ctx: ExtensionContext;
  cwd: string;
  /** Which lease the substrate actually runs under. */
  lease: "exclusive" | "shared";
  baseConfig: SandboxRuntimeConfig;
  grant: Grant | undefined;
}

export interface GuardedSpec<P, OU, R> {
  /** Authorization label; also the assertExecutionAuthorized tool key. */
  toolName: string;
  /** Lease policy, decided from the pre-spend grant peek. */
  leaseFor: (grant: Grant | undefined) => "exclusive" | "shared";
  /** Unsandboxed execution (yolo fast path, sandbox off, carve-outs). */
  bare: (inv: {
    id: string;
    params: P;
    signal: AbortSignal | undefined;
    onUpdate: OU;
    ctx: ExtensionContext;
  }) => Promise<R>;
  /** Sandboxed body; runs only when the grant validated and the lease held. */
  runInLease: (inv: LeasedInvocation<P, OU>) => Promise<R>;
}

function abortedResult<R>(): R {
  // Shape mirrors what the retired core gate returned; `details` is present
  // so generic inference unifies with base tool results.
  return {
    content: [{ type: "text", text: ABORTED_TOOL_MESSAGE }],
    isError: true,
    details: undefined,
  } as R;
}

export function makeGuardedExecute<P extends Record<string, unknown>, OU, R>(
  host: EnforcerHost<unknown>,
  spec: GuardedSpec<P, OU, R>,
): (
  id: string,
  params: P,
  signal: AbortSignal | undefined,
  onUpdate: OU,
  ctx: ExtensionContext,
) => Promise<R> {
  return async (id, params, signal, onUpdate, ctx) => {
    if (signal?.aborted) return abortedResult<R>();

    const snap = await host.activate(ctx);

    if (snap.privilegeMax === "yolo") {
      host.revokeGrant(id);
      return spec.bare({ id, params, signal, onUpdate, ctx });
    }

    const lease = spec.leaseFor(host.peekGrant(id));
    return host.coordinate(lease, signal, async () => {
      const grant = await host.authorize(spec.toolName, id, params, ctx, snap.raw);
      if (!snap.sandboxEnabled) {
        return spec.bare({ id, params, signal, onUpdate, ctx });
      }
      if (!snap.sandboxReady || !snap.baseSandboxConfig) {
        throw new Error(`pi-permissions sandbox unavailable: ${host.sandboxUnavailableReason()}`);
      }
      return spec.runInLease({
        id,
        params,
        signal,
        onUpdate,
        ctx,
        cwd: ctx.cwd,
        lease,
        baseConfig: snap.baseSandboxConfig,
        grant,
      });
    });
  };
}
