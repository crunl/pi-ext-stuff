import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SafetyConfig } from "./config.ts";
import type { GuardianTranscriptEntry } from "./guardian-transcript.ts";
import { renderPermissionErrorForAgent } from "./permission-copy.ts";
import { effectiveNetworkAuthority } from "./policy-primitives.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";
import type { PermissionMode } from "./state.ts";
import { isRecord } from "./unknown-value.ts";

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

/** Pi 0.85.1 createBashTool leaves timeout unset; escalated path normalizes at ingress.
 * Keep in lockstep with sandbox.ts DEFAULT_BASH_TIMEOUT_MS (SRT bash path). */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
export const MAX_BASH_TIMEOUT_SECONDS = 2_147_483.647;

export function normalizeEscalatedBashTimeout(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return DEFAULT_BASH_TIMEOUT_SECONDS;
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > MAX_BASH_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `Invalid timeout: must be a finite number greater than 0 and at most ${MAX_BASH_TIMEOUT_SECONDS} seconds`,
    );
  }
  return timeout;
}

export function policyDeniedError(reason: string): Error {
  return Object.assign(
    new Error(renderPermissionErrorForAgent({ code: "policy-denied", reason })),
    { code: "policy-denied", reason },
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

export function requiresNetworkQuiescence(
  network: SandboxPolicy["network"] | undefined,
): boolean {
  if (!network) return false;
  const authority = effectiveNetworkAuthority(network);
  return (
    (network.access?.kind === "explicit" && network.access.transport === "direct") ||
    network.macosTls === "system" ||
    authority.localBinding
  );
}

export function stableSessionId(ctx: Pick<ExtensionContext, "sessionManager">, generation: number): string {
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
