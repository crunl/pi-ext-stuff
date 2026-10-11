export function partitionExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
): { mode: string | undefined; remaining: Array<[string, string]> } {
	const publishedMode = statuses.get("pi-safety");
	return {
		mode: publishedMode,
		remaining: [...statuses.entries()].filter(([key]) => key !== "pi-safety"),
	};
}

export function syncPermissionsMode(
	statuses: ReadonlyMap<string, string>,
): Array<[string, string]> {
	return partitionExtensionStatuses(statuses).remaining;
}
