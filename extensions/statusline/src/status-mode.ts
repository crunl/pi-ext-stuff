export interface ModelStatusInfo {
	provider: string;
	modelId: string;
	effort: string | undefined;
}

export function formatModelStatus(
	info: ModelStatusInfo,
	mode: string | undefined,
): string {
	if (mode) {
		return `${mode}•(${info.provider}) ${info.modelId}${info.effort ? `•${info.effort}` : ""}`;
	}
	return `(${info.provider}) ${info.modelId}${info.effort ? ` • ${info.effort}` : ""}`;
}

export function partitionExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
): { mode: string | undefined; remaining: Array<[string, string]> } {
	const publishedMode = statuses.get("pi-permissions");
	return {
		mode: publishedMode === "Default" ? undefined : publishedMode,
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
