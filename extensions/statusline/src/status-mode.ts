export interface ModelStatusInfo {
	provider: string;
	modelId: string;
	effort: string | undefined;
}

/** Bottom-border label: model identity only (mode lives in the top border). */
export function formatModelStatus(info: ModelStatusInfo): string {
	return `(${info.provider}) ${info.modelId}${info.effort ? ` • ${info.effort}` : ""}`;
}

export function partitionExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
): { mode: string | undefined; remaining: Array<[string, string]> } {
	const publishedMode = statuses.get("pi-permissions");
	return {
		mode: publishedMode === "default" ? undefined : publishedMode,
		remaining: [...statuses.entries()].filter(([key]) => key !== "pi-permissions"),
	};
}

export class PermissionsModeState {
	#value: string | undefined;

	get(): string | undefined {
		return this.#value;
	}

	update(value: string | undefined): boolean {
		if (this.#value === value) return false;
		this.#value = value;
		return true;
	}
}

export function syncPermissionsMode(
	statuses: ReadonlyMap<string, string>,
	state: PermissionsModeState,
	requestRender: () => void,
): Array<[string, string]> {
	const { mode, remaining } = partitionExtensionStatuses(statuses);
	if (state.update(mode)) requestRender();
	return remaining;
}
