import assert from "node:assert/strict";
import test from "node:test";
import {
	isPermissionsModeEvent,
	PermissionsModeState,
} from "../../../packages/shared-tool-presentation/src/permissions-mode.ts";
import {
	partitionExtensionStatuses,
	powerlineChain,
	syncPermissionsMode,
} from "../src/status-mode.ts";

test("powerlineChain joins N segments with caps and seps", () => {
	const out = powerlineChain([
		{ text: "A", ansi: "\x1b[38;2;10;10;10m" },
		{ text: "B", ansi: "\x1b[38;2;20;20;20m" },
		{ text: "C" },
	]);
	assert.ok(out.startsWith("\x1b[38;2;10;10;10m"));
	assert.ok(out.includes("A"));
	assert.ok(out.includes("B"));
	assert.ok(out.includes("C"));
	// two separators between three segments
	assert.equal(out.split("").length, 3);
});

test("powerlineChain returns empty for no segments", () => {
	assert.equal(powerlineChain([]), "");
});

test("partition splits pi-safety from unrelated statuses", () => {
	const result = partitionExtensionStatuses(
		new Map([
			["other", "Indexing"],
			["pi-safety", "default"],
		]),
	);
	assert.equal(result.mode, "default");
	assert.deepEqual(result.remaining, [["other", "Indexing"]]);
});

test("validates structured mode events", () => {
	assert.equal(
		isPermissionsModeEvent({
			mode: "yolo",
			label: "Full bypass",
			severity: "error",
		}),
		true,
	);
	assert.equal(
		isPermissionsModeEvent({ mode: "yolo", label: "Full bypass" }),
		false,
	);
	assert.equal(
		isPermissionsModeEvent({
			mode: "yolo",
			label: "Full bypass",
			severity: "fatal",
		}),
		false,
	);
	assert.equal(isPermissionsModeEvent(undefined), false);
	assert.equal(isPermissionsModeEvent("full bypass"), false);
});

test("event severity drives badge visibility and color", () => {
	const state = new PermissionsModeState();
	assert.equal(
		state.applyEvent({ mode: "default", label: "default", severity: "none" }),
		false,
	);
	assert.equal(state.get(), undefined);

	assert.equal(
		state.applyEvent({ mode: "yolo", label: "Full bypass", severity: "error" }),
		true,
	);
	assert.equal(state.get(), "Full bypass");
	assert.equal(state.severity(), "error");

	// Renamed label with same severity still renders — no string coupling.
	assert.equal(
		state.applyEvent({
			mode: "yolo",
			label: "renamed later",
			severity: "error",
		}),
		true,
	);
	assert.equal(state.get(), "renamed later");
	assert.equal(state.severity(), "error");
});

test("mode state reports only distinct changes", () => {
	const state = new PermissionsModeState();
	const event = {
		mode: "auto",
		label: "approve for me",
		severity: "warning",
	} as const;
	assert.equal(state.applyEvent(event), true);
	assert.equal(state.applyEvent(event), false);
	assert.equal(state.reset(), true);
	assert.equal(state.reset(), false);
});

test("sync strips pi-safety from the statuses shown in the footer", () => {
	const statuses = new Map([
		["other", "Indexing"],
		["pi-safety", "Approve for me"],
	]);

	assert.deepEqual(
		syncPermissionsMode(statuses),
		[["other", "Indexing"]],
	);
});
