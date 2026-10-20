/**
 * The `request_permissions` tool — the one entry point that widens this turn's
 * authority rather than exercising it.
 *
 * It is registered apart from bash/write/edit because it is a policy surface,
 * not a capability: those three do work, this one amends the lease they work
 * under. Dependencies arrive as one object so the registration stays readable
 * and the tool cannot reach Engine state that is none of its business.
 */
import { resolve } from "node:path";
import type {
  createWriteTool,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { DelegationScope } from "./delegation-policy.ts";
import { checkDelegationNetwork, checkDelegationWrite } from "./delegation-policy.ts";
import { resolvePolicyPath } from "./filesystem-policy.ts";
import type { GuardianTranscriptEntry } from "./guardian-transcript.ts";
import type { PiGuardianReviewContext } from "./pi-approve-for-me-adapters.ts";
import type { PiAction, PiActionOutcome, PiSafetyRuntime } from "./pi-safety.ts";
import type { EffectiveExecutionContext, PreparedPermissionExecution } from "./register-support.ts";
import { policyDeniedError } from "./register-support.ts";
import { requestPermissionsDescription } from "./register-tool-copy.ts";
import type { ReviewPartialResult } from "./review-renderer.ts";
import {
  createReviewResultRenderer,
  createReviewStatusBridge,
  plainReviewResultRenderer,
} from "./review-renderer.ts";
import type { RiskDecision } from "./risk-policy.ts";
import { isSupportedPermissionRequestShape } from "./risk-policy.ts";

/** The tool result shape a host write/edit execution returns. */
type WriteResult = Awaited<ReturnType<ReturnType<typeof createWriteTool>["execute"]>>;

export interface RequestPermissionsToolDeps {
  /** The Engine itself: submits the action and reports the outcome. */
  readonly executePermissionAction: <T, Input>(
    action: PiAction<T, PiGuardianReviewContext, Input>,
  ) => Promise<T>;
  readonly preparePermissionExecution: (
    ctx: ExtensionContext,
  ) => Promise<PreparedPermissionExecution>;
  readonly evaluateManagedRisk: (
    tool: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
    executionContext: EffectiveExecutionContext,
    cwd?: string,
  ) => Promise<RiskDecision>;
  readonly createPiGuardianReviewContext: (
    event: ToolCallEvent,
    executionContext: EffectiveExecutionContext,
    ctx: ExtensionContext,
    transcript?: GuardianTranscriptEntry[],
    canonicalCwd?: string,
  ) => PiGuardianReviewContext;
  readonly delegationScope: () => DelegationScope;
  readonly currentGuardianTranscriptSnapshot: () => GuardianTranscriptEntry[];
  readonly session: { activeDelegationCeiling(): unknown };
  readonly permissions: Pick<PiSafetyRuntime<PiGuardianReviewContext>, "captureAction">;
}

export function registerRequestPermissionsTool(
  pi: ExtensionAPI,
  deps: RequestPermissionsToolDeps,
): void {
  pi.registerTool({
    name: "request_permissions",
    label: "request_permissions",
    description: requestPermissionsDescription,
    promptSnippet: "Request explicit filesystem/network permissions",
    parameters: Type.Object({
      reason: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Literal("turn")),
      permissions: Type.Object({
        file_system: Type.Optional(Type.Object({ write: Type.Array(Type.String()) })),
        network: Type.Optional(
          Type.Union([
            Type.Object({ hosts: Type.Array(Type.String()) }),
            Type.Object({ network_access: Type.Literal(true) }),
          ]),
        ),
      }),
    }),
    // SAFETY: same renderer-wrapper contract as addReviewResultRenderer —
    // identical input/output behavior, assertion only bridges host generics.
    renderResult: createReviewResultRenderer(
      plainReviewResultRenderer,
      "overlay",
    ) as unknown as NonNullable<ToolDefinition<TSchema>["renderResult"]>,
    // Machine-readable grant for codemode callers; the model still receives
    // `content` text. Deliberately no readOnlyHint: a permission grant is a
    // privilege-escalation entry point and must keep the MCP-default
    // "not read-only, may be destructive" posture toward external reviewers.
    outputSchema: Type.Object({
      granted: Type.Boolean(),
      networkAll: Type.Boolean(),
      hosts: Type.Array(Type.String()),
      writeRoots: Type.Array(Type.String()),
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      if (!isSupportedPermissionRequestShape(params)) {
        const reason =
          "request_permissions requires an unambiguous turn-scoped network.hosts OR network_access:true request, and/or file_system.write";
        throw policyDeniedError(reason);
      }
      const captured = deps.permissions.captureAction({
        id,
        tool: "request_permissions",
        input: params,
        cwd: resolve(ctx.cwd),
      });
      const { call } = captured;
      const actionId = call.id;
      const canonicalCwd = call.cwd;
      const canonicalParams = call.input;
      const capturedTranscript = deps.currentGuardianTranscriptSnapshot();
      const { executionSnapshot, executionContext } = await deps.preparePermissionExecution(ctx);
      const decision = await deps.evaluateManagedRisk(
        "request_permissions",
        canonicalParams as Record<string, unknown>,
        ctx,
        executionContext,
        canonicalCwd,
      );
      if (decision.action === "block") {
        throw policyDeniedError(decision.reason, decision.recoverable);
      }
      if (
        decision.action !== "prompt" ||
        (!decision.networkAll &&
          (decision.networkHosts?.length ?? 0) === 0 &&
          (decision.filesystemWriteRoots?.length ?? 0) === 0)
      ) {
        throw policyDeniedError("request_permissions requires a non-empty capability request");
      }
      if (decision.networkAll && deps.session.activeDelegationCeiling()) {
        throw policyDeniedError("Whole-network authority is outside the delegation envelope");
      }
      // A nested amendment may only request capabilities inside its
      // delegation envelope; the child Engine would otherwise accumulate
      // rights the parent never granted it.
      for (const root of decision.filesystemWriteRoots ?? []) {
        const violation = checkDelegationWrite(
          resolvePolicyPath(root, canonicalCwd),
          executionSnapshot.mode,
          executionContext.config,
          deps.delegationScope(),
        );
        if (violation) {
          throw policyDeniedError(violation);
        }
      }
      for (const host of decision.networkHosts ?? []) {
        const violation = checkDelegationNetwork(
          host,
          executionSnapshot.mode,
          deps.delegationScope(),
        );
        if (violation) {
          throw policyDeniedError(violation);
        }
      }
      const canonicalReason =
        typeof canonicalParams.reason === "string" ? canonicalParams.reason : undefined;
      const reason = canonicalReason ?? decision.reason;
      const event = {
        type: "tool_call" as const,
        toolCallId: actionId,
        toolName: "request_permissions",
        input: canonicalParams,
      } as ToolCallEvent;
      // SAFETY: same bridge contract as the bash path — only ReviewPartialResult
      // payloads reach the host update channel.
      const reviewBridge = createReviewStatusBridge(
        onUpdate as unknown as (result: ReviewPartialResult) => void,
        ctx.hasUI ? (message, severity) => ctx.ui.notify(message, severity) : undefined,
      );
      const action: PiAction<WriteResult, PiGuardianReviewContext, typeof canonicalParams> = {
        captured,
        kind: "permission-amendment",
        risk: decision,
        permission: {
          reason,
        },
        reviewContext: deps.createPiGuardianReviewContext(
          event,
          executionContext,
          ctx,
          capturedTranscript,
          canonicalCwd,
        ),
        signal: signal,
        reviewStatus: reviewBridge.binding,
        execute: async ({
          mode,
          policy,
          signal: attemptSignal,
        }): Promise<PiActionOutcome<WriteResult>> => {
          try {
            if (attemptSignal.aborted) return { kind: "failed", error: new Error("aborted") };
            if (mode === "unrestricted") {
              return {
                kind: "completed",
                value: {
                  content: [
                    {
                      type: "text",
                      text: "Bypass permissions is already active; no additional permission grant was recorded.",
                    },
                  ],
                  details: undefined,
                  // Host forwards unknown result fields to tool_result
                  // (agent-deps.session spread); AgentToolResult omits the field
                  // by type, same as the host bash tool's own literal.
                  structuredContent: {
                    granted: false,
                    networkAll: false,
                    hosts: [],
                    writeRoots: [],
                  },
                } as WriteResult,
              };
            }
            if (mode !== "sandboxed" || !policy) {
              return {
                kind: "failed",
                error: new Error("Sandbox enforcement is unavailable for this action"),
              };
            }
            const grantedHosts = [...(decision.networkHosts ?? [])];
            const grantedRoots = [...(decision.filesystemWriteRoots ?? [])];
            return {
              kind: "completed",
              value: {
                content: [
                  {
                    type: "text",
                    text: `Granted turn deps.permissions${decision.networkAll ? "; whole-network outbound authority subject to hard domain/private policy (not bind or TLS authority)" : ""}${
                      grantedHosts.length > 0 ? `; hosts: ${grantedHosts.join(", ")}` : ""
                    }${grantedRoots.length > 0 ? `; write roots: ${grantedRoots.join(", ")}` : ""}`,
                  },
                ],
                details: undefined,
                // Same host-forwarding contract as the bypass branch above.
                structuredContent: {
                  granted: true,
                  networkAll: decision.networkAll ?? false,
                  hosts: grantedHosts,
                  writeRoots: grantedRoots,
                },
              } as WriteResult,
            };
          } catch (error: unknown) {
            return { kind: "failed", error };
          }
        },
      };
      return deps.executePermissionAction(action);
    },
  });
}
