import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SafetyConfig } from "./config.ts";
import type { GuardianTranscriptEntry } from "./guardian-transcript.ts";
import { renderPermissionErrorForAgent } from "./permission-copy.ts";
import { effectiveNetworkAuthority } from "./policy-primitives.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";
import type { PermissionExecutionSnapshot } from "./permission-session.ts";
import type { PermissionMode } from "./state.ts";
import { isRecord } from "./unknown-value.ts";
import type { BlockRecoverability } from "./approve-for-me-engine.ts";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part) || typeof part.type !== "string") return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "image") return "[image]";
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function assistantContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part) || typeof part.type !== "string") return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "toolCall") {
        return JSON.stringify({
          toolCall: typeof part.name === "string" ? part.name : "",
          arguments: isRecord(part.arguments) ? part.arguments : {},
        });
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

export function guardianTranscriptEntryFromMessage(
  message: unknown,
): GuardianTranscriptEntry | undefined {
  if (!isRecord(message)) return undefined;
  if (message.role === "user") {
    const content = textContent(message.content);
    return content.length > 0 ? { role: "user", content } : undefined;
  }
  if (message.role === "assistant") {
    const content = assistantContent(message.content);
    return content.length > 0 ? { role: "assistant", content } : undefined;
  }
  if (message.role === "toolResult") {
    const content = textContent(message.content);
    return {
      role: "tool",
      toolName: typeof message.toolName === "string" ? message.toolName : "",
      content,
      isError: message.isError === true,
    };
  }
  return undefined;
}

export function requiresSandbox(mode: PermissionMode, config: SafetyConfig): boolean {
  return mode !== "yolo" && config.sandbox.enabled;
}

export function nextMode(mode: PermissionMode): PermissionMode {
  return mode === "auto" ? "yolo" : "auto";
}

export function policyDeniedError(reason: string, recoverable?: BlockRecoverability): Error {
  return Object.assign(
    new Error(
      renderPermissionErrorForAgent({
        code: "policy-denied",
        reason,
        ...(recoverable === undefined ? {} : { recoverable }),
      }),
    ),
    { code: "policy-denied", reason, ...(recoverable === undefined ? {} : { recoverable }) },
  );
}

export class ActivationSupersededError extends Error {
  constructor() {
    super("pi-safety: permission activation was superseded by a newer session");
    this.name = "ActivationSupersededError";
  }
}

export function isActivationSupersededError(error: unknown): error is ActivationSupersededError {
  return error instanceof ActivationSupersededError;
}

export const PERMISSION_MODE_CHANGED_REASON = "permission mode changed";
export const ACTIVE_PERMISSION_CONTEXT_UNAVAILABLE =
  "The active permission context is unavailable. Retry in the current task.";

/** Owned tools: same-name registerTool.execute owns risk → Engine → SRT. */
export const PI_OWNED_TOOL_NAMES = new Set(["bash", "write", "edit", "request_permissions"]);

/**
 * Pi host-first read-only tools: tool_call B (rules deny only). Foreign
 * MCP/custom tools are out of scope (A pass-through).
 */
export const PI_HOST_FIRST_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

/** Tools that mint a delegated child turn instead of executing: the parent
 * declares the child's upper bound here, enforced as a ceiling for the
 * whole nested turn. */
export const DELEGATED_TOOL_NAMES = new Set(["subagent"]);

/**
 * Fail closed when a live turn loses its permission context (a branch
 * switch or reload narrowing a YOLO run) or cannot trust it (a setup
 * failure while in yolo): an unrestricted turn must not continue
 * unreviewed.
 */
export function abortLiveTurn(ctx: Pick<ExtensionContext, "isIdle" | "abort">): void {
  if (!ctx.isIdle()) ctx.abort();
}

export function requiresNetworkQuiescence(network: SandboxPolicy["network"] | undefined): boolean {
  if (!network) return false;
  const authority = effectiveNetworkAuthority(network);
  return (
    (network.access?.kind === "explicit" && network.access.transport === "direct") ||
    network.macosTls === "system" ||
    authority.localBinding
  );
}

export function stableSessionId(
  ctx: Pick<ExtensionContext, "sessionManager">,
  generation: number,
): string {
  // SAFETY: the host always supplies a sessionManager object; only the
  // optional getSessionId shape is assumed, and every use below is guarded
  // (optional chaining, typeof check, try/catch with a fallback id).
  const sessionManager = ctx.sessionManager as unknown as
    | { getSessionId?: () => unknown }
    | undefined;
  if (typeof sessionManager?.getSessionId === "function") {
    try {
      const sessionId = sessionManager.getSessionId();
      if (typeof sessionId === "string" && sessionId.trim().length > 0) return sessionId;
    } catch {
      // Compatibility test doubles may expose a throwing session manager.
    }
  }
  return `pi-safety-session-${generation}`;
}

export function configKey(ctx: Pick<ExtensionContext, "cwd">): string {
  return ctx.cwd;
}

/**
 * Env-gated turn tracing (PI_SAFETY_TRACE=1): pure helpers, zero cost when
 * the gate is off. `traceSpan` measures a named segment of a tool call's
 * extension-side pipeline; `flushTurnTrace` appends one JSON line per call
 * to {agentDir}/turn-trace.jsonl via the caller's best-effort sink. The
 * `review` segment (LLM wait) is recorded separately so it can be
 * subtracted — extension_ms never includes it.
 */
export const TURN_TRACE_ENV = "PI_SAFETY_TRACE";

/** The mode a registered tool actually executes under after activation. */
export type ExecutablePermissionMode = PermissionMode;

/**
 * What a prepared permission call executes against: the applied snapshot, the
 * mode it was captured in, and the config that produced it. Shared by the
 * registration and by the request_permissions tool so both read one shape.
 */
export interface EffectiveExecutionContext {
  readonly snapshot: PermissionExecutionSnapshot;
  readonly mode: ExecutablePermissionMode;
  readonly config: SafetyConfig;
  readonly baseSandboxConfig?: SandboxPolicy;
  readonly sandboxReady: boolean;
}

/** The pair returned by preparePermissionExecution. */
export interface PreparedPermissionExecution {
  readonly executionSnapshot: PermissionExecutionSnapshot;
  readonly executionContext: EffectiveExecutionContext;
}

export interface TurnTraceSegments {
  capture?: number;
  prepare?: number;
  risk?: number;
  admit?: number;
  review?: number;
  execute?: number;
  diagnose?: number;
}

export function turnTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TURN_TRACE_ENV] === "1";
}

/** Measures `fn` in milliseconds when tracing is on; passes through otherwise. */
export async function traceSpan<T>(
  enabled: boolean,
  segments: TurnTraceSegments,
  name: keyof TurnTraceSegments,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    segments[name] = (segments[name] ?? 0) + (performance.now() - start);
  }
}

export interface TurnTraceRecord {
  schema: 1;
  id: string;
  tool: string;
  mode: string;
  segments: TurnTraceSegments;
  /** Sum of extension-side segments, excluding review (LLM) and command wait. */
  extension_ms: number;
}

export function buildTurnTraceRecord(
  id: string,
  tool: string,
  mode: string,
  segments: TurnTraceSegments,
): TurnTraceRecord {
  const { review: _review, ...extensionSegments } = segments;
  const extensionMs = Object.values(extensionSegments).reduce(
    (sum, value) => sum + (value ?? 0),
    0,
  );
  return { schema: 1, id, tool, mode, segments, extension_ms: extensionMs };
}

/**
 * Best-effort JSONL append to {agentDir}/turn-trace.jsonl, mirroring the
 * guardian-metrics sink contract: observational, never throws into the
 * authorization path.
 */
export async function flushTurnTrace(
  id: string,
  tool: string,
  mode: string,
  segments: TurnTraceSegments,
  agentDirectory: string,
): Promise<void> {
  try {
    const { appendFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const record = buildTurnTraceRecord(id, tool, mode, segments);
    await appendFile(join(agentDirectory, "turn-trace.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {
    // Tracing is observational; never surface sink failures.
  }
}
