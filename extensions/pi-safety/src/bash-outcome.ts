import type { JsonValue } from "@earendil-works/pi-ai";
import type { BashOperations, BashToolDetails } from "@earendil-works/pi-coding-agent";

import type { PiActionOutcome } from "./pi-safety.ts";
import { looksLikeSandboxDenial, type SandboxDenialCapability } from "./sandbox-policy.ts";
import { errorMessage } from "./unknown-value.ts";

// A completed command reports its status on the result channel.
// Pi 1.x *returns* a non-zero exit as an error result (`isError`
// plus the structured exit code in `structuredContent`) and
// throws only signal terminations, aborts, timeouts, and
// infrastructure failures; Pi 0.86 *throws* every non-zero or
// null status as an error whose message ends with the rendered
// status line. The exit code is a structured value at the
// operations seam in both versions; capture it there instead of
// parsing the rendered text back out.
//
// A captured status (including null, which Pi reports as "no
// exit code") means the child ran far enough to report one, so
// what follows is the command's result rather than a permission
// failure. The one exception is the sandboxed branch, where an
// authoritative SRT denial is checked first and wins over this
// classification.
//
// `backend` names which executor the wrapper delegated to, so
// test doubles can route a call to the right simulated backend
// without string matching.

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

/**
 * A completed command's result — the shape Pi's bash execute returns.
 * `isError` is honored by Pi 1.x's agent loop on a returned result;
 * Pi 0.86 hardcodes returned results to `isError: false`, so the
 * `tool_result` hook re-marks the outcome there.
 */
export type BashOutcome = {
  content: Array<{ type: "text"; text: string }>;
  details: BashOutcomeDetails;
  readonly isError: true;
  /** The host's machine-readable result, preserved from the Pi 1.x
   * return contract so programmatic callers keep the full output. */
  readonly structuredContent?: JsonValue;
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
  // Pi 1.x reaches this only for a signal termination (its non-zero exits
  // are returned, not thrown); Pi 0.86 and the test doubles throw both.
  if (!errorMessage(status).endsWith(commandStatusSuffix(slot.code))) return undefined;
  return {
    content: [{ type: "text", text: errorMessage(presented) }],
    // The captured status is the structured marker that tells the `tool_result`
    // handler this completed action is a failed *command*; nothing here parses
    // the rendered text back out.
    details: { exitCode: slot.code },
    isError: true,
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

/**
 * A command failure Pi 1.x's bash tool *returned* rather than threw:
 * an error result carrying the structured exit code. The return is
 * itself the proof the command ran and reported a status, so — unlike
 * the thrown path — no message validation is needed.
 */
export type ReturnedBashFailure = {
  readonly exitCode: number;
  readonly content: Array<{ type: "text"; text: string }>;
  readonly details: BashToolDetails | undefined;
  readonly structuredContent: JsonValue | undefined;
};

export function returnedBashFailure(result: unknown): ReturnedBashFailure | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const candidate = result as {
    isError?: unknown;
    content?: unknown;
    details?: BashToolDetails | undefined;
    structuredContent?: JsonValue | undefined;
  };
  if (candidate.isError !== true || !Array.isArray(candidate.content)) return undefined;
  const structured = candidate.structuredContent;
  const exitCode =
    structured !== null && typeof structured === "object"
      ? (structured as { exit_code?: unknown }).exit_code
      : undefined;
  if (typeof exitCode !== "number") return undefined;
  return {
    exitCode,
    content: candidate.content as Array<{ type: "text"; text: string }>,
    details: candidate.details,
    structuredContent: candidate.structuredContent,
  };
}

/** The command's own failure text (all content parts). */
export function bashFailureText(failure: ReturnedBashFailure): string {
  return failure.content.map((part) => part.text).join("\n");
}

/**
 * Builds the internal outcome for a returned command failure, with the
 * captured status riding in `details` so every downstream reader (the
 * `tool_result` hook, test doubles) sees one currency regardless of
 * which contract produced it. `text` replaces the content when failure
 * diagnostics were appended; the host's rendering already ends with the
 * status line.
 */
export function completedBashFailure(
  failure: ReturnedBashFailure,
  text = bashFailureText(failure),
): BashOutcome {
  return {
    content: [{ type: "text", text }],
    details: { ...failure.details, exitCode: failure.exitCode },
    structuredContent: failure.structuredContent,
    isError: true,
  };
}

/**
 * Recognizes a Pi 1.x returned command failure and builds the
 * completed-command outcome for it. `undefined` means the result is
 * not a returned command failure — a success, or a thrown status
 * (handled by `completedIfCommandRan`).
 */
export function completedBashFromResult(result: unknown): BashOutcome | undefined {
  const failure = returnedBashFailure(result);
  return failure ? completedBashFailure(failure) : undefined;
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
