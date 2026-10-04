/** Structured permissions-mode state consumed by status UI.
 *
 * Consumers must key visibility/color off `severity`; `label` is display
 * copy emitted atomically by pi-safety's `pi-safety:mode` event.
 */

export type ModeSeverity = "none" | "warning" | "error";

export interface PermissionsModeEvent {
  mode: string;
  label: string;
  severity: ModeSeverity;
}

export function isPermissionsModeEvent(data: unknown): data is PermissionsModeEvent {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record.mode === "string" &&
    typeof record.label === "string" &&
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
