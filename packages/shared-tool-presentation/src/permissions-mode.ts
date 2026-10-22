/** Structured permissions-mode state consumed by status UI.
 *
 * `mode` is the canonical machine value (`auto` / `yolo`). The display mapping
 * (`auto` -> "Approve for me", `yolo` -> "Bypass permissions") is applied only
 * when this event is emitted, and lives only in `label`. Consumers key
 * visibility/color off `severity` and logic off `mode`; they must not parse
 * `label` back into a mode.
 */

export type ModeSeverity = "none" | "warning" | "error";

export interface PermissionsModeEvent {
  mode: "auto" | "yolo";
  label: string;
  severity: ModeSeverity;
  /**
   * Desired mode not yet applied (mid-turn cycle: enforcement stays on
   * `mode` until the step boundary). Absent when display matches
   * enforcement. Consumers may ignore it; the label already carries a
   * pending marker in that case.
   */
  pending?: "auto" | "yolo";
}

export function isPermissionsModeEvent(data: unknown): data is PermissionsModeEvent {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    (record.mode === "auto" || record.mode === "yolo") &&
    typeof record.label === "string" &&
    (record.pending === undefined || record.pending === "auto" || record.pending === "yolo") &&
    (record.severity === "none" ||
      record.severity === "warning" ||
      record.severity === "error")
  );
}

export class PermissionsModeState {
  #label: string | undefined;
  #severity: ModeSeverity = "none";

  /** Badge text, or undefined when the badge is hidden. */
  get(): string | undefined {
    return this.#severity === "none" ? undefined : this.#label;
  }

  severity(): ModeSeverity {
    return this.#severity;
  }

  /** Apply a structured event. Returns true when the badge should re-render. */
  applyEvent(event: PermissionsModeEvent): boolean {
    return this.#set(event.label, event.severity);
  }

  /** Reset to hidden (e.g. extension uninstall). */
  reset(): boolean {
    return this.#set(undefined, "none");
  }

  #set(label: string | undefined, severity: ModeSeverity): boolean {
    const effectiveLabel = severity === "none" ? undefined : label;
    if (this.#label === effectiveLabel && this.#severity === severity) return false;
    this.#label = effectiveLabel;
    this.#severity = severity;
    return true;
  }
}
