import assert from "node:assert/strict";
import test from "node:test";
import {
	formatModelStatus,
	partitionExtensionStatuses,
	PermissionsModeState,
	syncPermissionsMode,
} from "../src/status-mode.ts";

const info = {
	provider: "tuzi",
	modelId: "gpt-5.6-sol-fast",
	effort: "xhigh",
};

test("formats compact mode, provider, model, and effort", () => {
	assert.equal(
		formatModelStatus(info, "Default"),
		"Default•(tuzi) gpt-5.6-sol-fast•xhigh",
	);
});

test("preserves the existing label when the mode is absent", () => {
	assert.equal(
		formatModelStatus(info, undefined),
		"(tuzi) gpt-5.6-sol-fast • xhigh",
	);
});

test("omits the effort separator when effort is absent", () => {
	assert.equal(
		formatModelStatus({ ...info, effort: undefined }, "Default"),
		"Default•(tuzi) gpt-5.6-sol-fast",
	);
});

test("extracts only pi-permissions and preserves unrelated statuses", () => {
	const result = partitionExtensionStatuses(new Map([
		["other", "Indexing"],
		["pi-permissions", "Default"],
	]));
	assert.equal(result.mode, "Default");
	assert.deepEqual(result.remaining, [["other", "Indexing"]]);
});

test("mode state reports only distinct changes", () => {
	const state = new PermissionsModeState();
	assert.equal(state.update("Default"), true);
	assert.equal(state.update("Default"), false);
	assert.equal(state.get(), "Default");
	assert.equal(state.update(undefined), true);
});

test("sync requests one render per distinct mode and returns other statuses", () => {
	const state = new PermissionsModeState();
	let renders = 0;
	const statuses = new Map([
		["other", "Indexing"],
		["pi-permissions", "Default"],
	]);

	assert.deepEqual(
		syncPermissionsMode(statuses, state, () => renders++),
		[["other", "Indexing"]],
	);
	syncPermissionsMode(statuses, state, () => renders++);
	assert.equal(renders, 1);

	syncPermissionsMode(
		new Map([["pi-permissions", "Plan"]]),
		state,
		() => renders++,
	);
	assert.equal(renders, 2);
});
