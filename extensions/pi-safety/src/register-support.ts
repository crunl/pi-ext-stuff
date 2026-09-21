import type { SafetyConfig } from "./config.ts";
import type { GuardianTranscriptEntry } from "./guardian-transcript.ts";
import type { PermissionMode } from "./state.ts";
import { isRecord } from "./unknown-value.ts";

export function textContent(content: unknown): string {
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

export function assistantContent(content: unknown): string {
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
