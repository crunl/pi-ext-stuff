import assert from "node:assert/strict";
import test from "node:test";
import {
	formatModelStatus,
	isPermissionsModeEvent,
	PermissionsModeState,
	partitionExtensionStatuses,
	powerlineChain,
	syncPermissionsMode,
} from "../src/status-mode.ts";

const info = {
	modelId: "gpt-5.6-sol-fast",
	effort: "xhigh",
};

test("formats model and effort as a powerline pill (inverse fallback)", () => {
	// First segment: trailing pad only. Later segments: lead + trail.
	assert.equal(
		formatModelStatus(info),
		"\uE0B6\x1b[7m\u{F035B} gpt-5.6-sol-fast \x1b[27m\uE0B0\x1b[7m \u{F0875} xhigh \x1b[27m\uE0B4",
	);
});

test("paints pill segments with the provided truecolor foregrounds", () => {
	const out = formatModelStatus(
		info,
		"\x1b[38;2;100;100;100m",
		"\x1b[38;2;200;50;50m",
	);
	assert.ok(out.includes("\x1b[48;2;100;100;100m"));
	assert.ok(out.includes("\x1b[48;2;200;50;50m"));
	assert.ok(out.includes("\x1b[38;2;100;100;100m\x1b[48;2;200;50;50m"));
});

test("omits the effort segment when effort is absent", () => {
	const out = formatModelStatus({ ...info, effort: undefined });
	assert.ok(out.includes("\u{F035B} gpt-5.6-sol-fast"));
	assert.ok(!out.includes("\u{F0875}"));
});

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

test("partition splits pi-permissions from unrelated statuses", () => {
	const result = partitionExtensionStatuses(
		new Map([
			["other", "Indexing"],
			["pi-permissions", "default"],
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

test("legacy labels map to severities until the first event arrives", () => {
	const state = new PermissionsModeState();
	assert.equal(state.applyLegacyLabel("default"), false);
	assert.equal(state.get(), undefined);

	assert.equal(state.applyLegacyLabel("Approve for me"), true);
	assert.equal(state.get(), "Approve for me");
	assert.equal(state.severity(), "warning");

	assert.equal(state.applyLegacyLabel("Full bypass"), true);
	assert.equal(state.severity(), "error");

	// Once events flow, legacy strings are ignored.
	state.applyEvent({ mode: "default", label: "default", severity: "none" });
	assert.equal(state.applyLegacyLabel("Full bypass"), false);
	assert.equal(state.get(), undefined);
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

test("sync requests one render per distinct legacy mode and returns other statuses", () => {
	const state = new PermissionsModeState();
	let renders = 0;
	const statuses = new Map([
		["other", "Indexing"],
		["pi-permissions", "default"],
	]);

	assert.deepEqual(
		syncPermissionsMode(statuses, state, () => renders++),
		[["other", "Indexing"]],
	);
	assert.equal(state.get(), undefined);
	syncPermissionsMode(statuses, state, () => renders++);
	assert.equal(renders, 0);

	syncPermissionsMode(
		new Map([["pi-permissions", "Approve for me"]]),
		state,
		() => renders++,
	);
	assert.equal(renders, 1);
	assert.equal(state.get(), "Approve for me");

	syncPermissionsMode(statuses, state, () => renders++);
	assert.equal(renders, 2);
	assert.equal(state.get(), undefined);
});
