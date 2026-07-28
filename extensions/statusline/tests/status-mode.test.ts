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

test("formats compact non-default mode, provider, model, and effort", () => {
	assert.equal(
		formatModelStatus(info, "Auto"),
		"Auto•(tuzi) gpt-5.6-sol-fast•xhigh",
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
		formatModelStatus({ ...info, effort: undefined }, "Auto"),
		"Auto•(tuzi) gpt-5.6-sol-fast",
	);
});

test("hides Default while preserving unrelated statuses", () => {
	const result = partitionExtensionStatuses(new Map([
		["other", "Indexing"],
		["pi-permissions", "Default"],
	]));
	assert.equal(result.mode, undefined);
	assert.deepEqual(result.remaining, [["other", "Indexing"]]);
});

test("keeps non-default permission modes visible", () => {
	const result = partitionExtensionStatuses(
		new Map([["pi-permissions", "Auto"]]),
	);
	assert.equal(result.mode, "Auto");
	assert.deepEqual(result.remaining, []);
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
	assert.equal(state.get(), undefined);
	syncPermissionsMode(statuses, state, () => renders++);
	assert.equal(renders, 0);

	syncPermissionsMode(
		new Map([["pi-permissions", "Auto"]]),
		state,
		() => renders++,
	);
	assert.equal(renders, 1);
	assert.equal(state.get(), "Auto");
});
