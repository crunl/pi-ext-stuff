export interface ModelStatusInfo {
	provider: string;
	modelId: string;
	effort: string | undefined;
}

/** Bottom-border label: model identity only (mode lives in the top border). */
export function formatModelStatus(info: ModelStatusInfo): string {
	return `(${info.provider}) ${info.modelId}${info.effort ? ` • ${info.effort}` : ""}`;
}

/** Badge severity published by pi-permissions ("none" hides the badge). */
export type ModeSeverity = "none" | "warning" | "error";

/** Structured mode event from pi-permissions ("pi-permissions:mode"). */
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
		(record.severity === "none" || record.severity === "warning" || record.severity === "error")
	);
}

/**
 * Legacy string fallback for pi-permissions builds that only publish
 * setStatus text. Kept in sync with the last known label set; the event
 * path makes future renames non-breaking.
 */
function legacySeverityFor(label: string): ModeSeverity {
	if (label === "default") return "none";
	if (label === "full bypass") return "error";
	return "warning";
}

export function partitionExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
): { mode: string | undefined; remaining: Array<[string, string]> } {
	const publishedMode = statuses.get("pi-permissions");
	return {
		mode: publishedMode,
		remaining: [...statuses.entries()].filter(([key]) => key !== "pi-permissions"),
	};
}

/**
 * Permissions badge state. Fed by two sources:
 * - preferred: structured "pi-permissions:mode" bus events (applyEvent)
 * - fallback: the setStatus string (applyLegacyLabel), used only until the
 *   first event arrives so old pi-permissions builds keep working.
 */
export class PermissionsModeState {
	#label: string | undefined;
	#severity: ModeSeverity = "none";
	#eventSeen = false;

	/** Badge text, or undefined when the badge is hidden. */
	get(): string | undefined {
		return this.#severity === "none" ? undefined : this.#label;
	}

	severity(): ModeSeverity {
		return this.#severity;
	}

	/** Apply a structured mode event. Returns true when a render is needed. */
	applyEvent(event: PermissionsModeEvent): boolean {
		this.#eventSeen = true;
		return this.#set(event.label, event.severity);
	}

	/** Apply the legacy setStatus string. Ignored once events are flowing. */
	applyLegacyLabel(label: string | undefined): boolean {
		if (this.#eventSeen) return false;
		if (label === undefined) return this.#set(undefined, "none");
		return this.#set(label, legacySeverityFor(label));
	}

	/** Reset (e.g. statusline uninstall). Keeps the event/legacy source flag. */
	reset(): boolean {
		return this.#set(undefined, "none");
	}

	#set(label: string | undefined, severity: ModeSeverity): boolean {
		// A hidden badge has no visible label: normalize so default→default
		// label churn never reports a spurious render.
		const effectiveLabel = severity === "none" ? undefined : label;
		if (this.#label === effectiveLabel && this.#severity === severity) return false;
		this.#label = effectiveLabel;
		this.#severity = severity;
		return true;
	}
}

export function syncPermissionsMode(
	statuses: ReadonlyMap<string, string>,
	state: PermissionsModeState,
	requestRender: () => void,
): Array<[string, string]> {
	const { mode, remaining } = partitionExtensionStatuses(statuses);
	if (state.applyLegacyLabel(mode)) requestRender();
	return remaining;
}
