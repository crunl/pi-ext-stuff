import type { BashOperations, BashToolDetails } from "@earendil-works/pi-coding-agent";

import type { PiActionOutcome } from "./pi-safety.ts";
import { looksLikeSandboxDenial, type SandboxDenialCapability } from "./sandbox-policy.ts";
import { errorMessage } from "./unknown-value.ts";

// Pi converts a completed child's non-zero or null exit code into a thrown
// error. The exit code is a structured value at the operations seam, before pi
// renders it into a message; capture it there instead of parsing the text back
// out.
//
// A captured status (including null, which pi reports as "no exit code") means
// the child ran far enough to report one, so what follows is the command's
// result rather than a permission failure. The one exception is the sandboxed
// branch, where an authoritative SRT denial is checked first and wins over this
// classification.
//
// `backend` names which executor the wrapper delegated to, so test doubles can
// route a call to the right simulated backend without string matching.

export type ExitCodeSlot = { code: number | null | undefined };

type CapturedBashOperations = BashOperations & {
  readonly backend: "sandboxed" | "local";
};

export type RuntimeDenialOutcome = Extract<PiActionOutcome<never>, { kind: "capability-denied" }>;

/**
 * Details of a completed command's result. Pi's `BashToolDetails` has no exit
 * code field, so the captured status rides along as an extra key; the host
 * passes tool details through to the `tool_result` event unchanged.
 */
export type BashOutcomeDetails = BashToolDetails & { exitCode: number | null };

/** A completed command's result — the shape pi's bash execute returns. */
type BashOutcome = {
  content: Array<{ type: "text"; text: string }>;
  details: BashOutcomeDetails;
};

export function captureExitCode(
  base: BashOperations,
  slot: ExitCodeSlot,
  backend: "sandboxed" | "local",
): CapturedBashOperations {
  return {
    backend,
    exec: async (command, cwd, options) => {
      const result = await base.exec(command, cwd, options);
      slot.code = result.exitCode;
      return result;
    },
  };
}

function commandStatusSuffix(code: number | null): string {
  return code === null
    ? "Command terminated without an exit code"
    : `Command exited with code ${code}`;
}

export function completedIfCommandRan(
  status: unknown,
  presented: unknown,
  slot: ExitCodeSlot,
): BashOutcome | undefined {
  // Only a child-reported failure status is its own result. Exit 0 never
  // reaches the catch through pi's normal path (pi returns it as success);
  // landing here with a 0 means a post-exec infrastructure error, which must
  // stay a failure.
  if (slot.code === undefined || slot.code === 0) return undefined;
  // Pi flushes the child's output *after* capturing the exit code, so a
  // non-zero status can be followed by an unrelated infrastructure failure.
  // The slot proves the child ran; this confirms the thrown error is that
  // status rather than the later failure, whose text must not be shown to the
  // model as if it were the command's output. `status` is the raw error —
  // diagnostics appended for the agent are checked around, not through.
  if (!errorMessage(status).endsWith(commandStatusSuffix(slot.code))) return undefined;
  return {
    content: [{ type: "text", text: errorMessage(presented) }],
    // The captured status is the structured marker that tells the `tool_result`
    // handler this completed action is a failed *command*; nothing here parses
    // the rendered text back out.
    details: { exitCode: slot.code },
  };
}

/**
 * Reads the command status a completed bash result carries, if any. `undefined`
 * means the result did not come from a command that reported a status — a
 * permission failure, or pi's own success path, which returns details without
 * an exit code.
 */
export function commandExitCode(details: unknown): number | null | undefined {
  if (details === null || typeof details !== "object") return undefined;
  const value = (details as { exitCode?: unknown }).exitCode;
  return typeof value === "number" || value === null ? value : undefined;
}

export function runtimeDenialFromEvidence(
  evidence: string,
  capability: SandboxDenialCapability | undefined,
): RuntimeDenialOutcome | undefined {
  if (!looksLikeSandboxDenial(evidence)) return undefined;
  // Network authorization happens before the connection through the SRT
  // callback. A post-failure network denial is not replayable because it would
  // reopen an entire command rather than authorize one connection.
  if (capability?.kind !== "filesystem") return undefined;
  const operation = capability.operation === "write" ? "writing" : "reading";
  const detail = `Sandbox enforcement denied ${operation} ${capability.path} during execution\nOriginal error: ${evidence}`;
  return { kind: "capability-denied", request: capability, detail };
}
