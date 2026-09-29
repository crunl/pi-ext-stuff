import assert from "node:assert/strict";
import test from "node:test";
import { BADGE_CAP_WIDTH } from "../src/badge.ts";
import { buildBottomBorder, buildTopBorder } from "../src/border-labels.ts";
import { applyBoxChrome } from "../src/model-editor.ts";

const WIDTH = 40;

test("top border: mode on the left", () => {
	const top = buildTopBorder(WIDTH, "Plan", undefined)!;
	assert.equal(top.pre, "──");
	assert.equal(top.mode, "Plan");
	assert.match(top.post, /^─+$/);
	// post is sized for the two powerline caps the decorator adds
	assert.equal(
		top.pre.length + top.mode.length + BADGE_CAP_WIDTH + top.post.length,
		WIDTH,
	);
});

test("top border: segments keep badge text undecorated", () => {
	const top = buildTopBorder(WIDTH, "Plan", { input: 1200, output: 300 })!;
	assert.equal(top.mode, "Plan"); // plain — caller decorates with caps
	assert.match(top.post, /^─+ ↑1\.2k ↓300 ──$/);
	assert.equal(
		top.pre.length + top.mode.length + BADGE_CAP_WIDTH + top.post.length,
		WIDTH,
	);
});

test("top border: mode left and stats right", () => {
	const top = buildTopBorder(WIDTH, "Plan", { input: 1200, output: 300 })!;
	const joined = top.pre + top.mode + top.post;
	assert.match(joined, /^──Plan─+ ↑1\.2k ↓300 ──$/);
	// raw join is 2 short of WIDTH; caps close the gap after decoration
	assert.equal(joined.length, WIDTH - BADGE_CAP_WIDTH);
});

test("top border: stats only when mode is absent", () => {
	const top = buildTopBorder(WIDTH, undefined, { input: 1200, output: 300 })!;
	assert.equal(top.pre, "");
	assert.equal(top.mode, "");
	assert.match(top.post, /^─+ ↑1\.2k ↓300 ──$/);
	assert.equal(top.post.length, WIDTH);
});

test("top border: drops stats when both sides cannot fit", () => {
	const top = buildTopBorder(24, "VeryLongModeName", {
		input: 1200,
		output: 300,
	})!;
	const joined = top.pre + top.mode + top.post;
	assert.ok(!joined.includes("↑"));
	assert.equal(joined.length, 24 - BADGE_CAP_WIDTH);
});

test("top border: untouched with no mode and no stats", () => {
	assert.equal(buildTopBorder(WIDTH, undefined, undefined), undefined);
	assert.equal(
		buildTopBorder(WIDTH, undefined, { input: 0, output: 0 }),
		undefined,
	);
});

test("bottom border: model info without the mode", () => {
	const bottom = buildBottomBorder(WIDTH, {
		modelId: "gpt-5.6",
		effort: "high",
	})!;
	assert.equal(bottom.pre, "──");
	// Uncolored pill: inverse bodies, plain caps/sep; flush against ──
	assert.match(
		bottom.pill,
		/^\uE0B6\x1b\[7m\u{F035B} gpt-5\.6 \x1b\[27m\uE0B0\x1b\[7m \u{F09D1} high \x1b\[27m\uE0B4$/u,
	);
	assert.match(bottom.post, /^─+$/);
	const plain = (bottom.pre + bottom.pill + bottom.post).replace(/\x1b\[[0-9;]*m/g, "");
	assert.equal([...plain].length, WIDTH);
});

test("bottom border: undefined when the label does not fit", () => {
	const bottom = buildBottomBorder(10, {
		modelId: "gpt-5.6-sol-fast",
		effort: "xhigh",
	});
	assert.equal(bottom, undefined);
});

test("bottom border: astral icons still leave a full-width rule", () => {
	// 2 icons × surrogate pair = UTF-16 length 4 but visible 2.
	const bottom = buildBottomBorder(30, { modelId: "m", effort: "high" })!;
	const plain = (bottom.pre + bottom.pill + bottom.post).replace(/\x1b\[[0-9;]*m/g, "");
	assert.equal([...plain].length, 30);
	assert.ok(plain.endsWith("─"));
});

test("applyBoxChrome: wraps editor in-place and preserves original properties", () => {
	const rawEditor = {
		customProp: 42,
		borderColor: (s: string) => `[c]${s}[/c]`,
		render: (width: number) => {
			const border = "─".repeat(width);
			return [border, "hello", border];
		},
	};

	const decorated = applyBoxChrome(rawEditor, {
		getPermissionsMode: () => ({ label: "Plan", severity: "warning" }),
		isEnabled: () => true,
	});

	assert.equal(decorated, rawEditor, "returns exact same object instance");
	assert.equal(decorated.customProp, 42);

	const lines = decorated.render(30);
	// Boxed with corner and rail
	assert.ok(lines[0]!.includes("╭"));
	assert.ok(lines[0]!.includes("Plan"));
	assert.ok(lines[lines.length - 1]!.includes("╰"));
});

test("applyBoxChrome: isEnabled=false transparently falls back to raw render", () => {
	let enabled = true;
	const rawEditor = {
		borderColor: (s: string) => s,
		render: (width: number) => {
			const border = "─".repeat(width);
			return [border, "input", border];
		},
	};

	const decorated = applyBoxChrome(rawEditor, {
		isEnabled: () => enabled,
	});

	// When enabled: boxed
	const boxedLines = decorated.render(30);
	assert.ok(boxedLines[0]!.startsWith("╭"));

	// When disabled: raw untouched render
	enabled = false;
	const rawLines = decorated.render(30);
	assert.equal(rawLines[0], "─".repeat(30));
	assert.equal(rawLines[1], "input");
	assert.equal(rawLines[2], "─".repeat(30));
});

test("applyBoxChrome: is idempotent on repeated calls", () => {
	let renderCount = 0;
	const rawEditor = {
		borderColor: (s: string) => s,
		render: (width: number) => {
			renderCount++;
			const border = "─".repeat(width);
			return [border, "input", border];
		},
	};

	applyBoxChrome(rawEditor);
	applyBoxChrome(rawEditor);

	rawEditor.render(30);
	assert.equal(renderCount, 1, "inner render called once per render() invocation");
});