import assert from "node:assert/strict";
import test from "node:test";
import { BADGE_CAP_WIDTH } from "../src/badge.ts";
import { buildBottomBorder, buildTopBorder } from "../src/border-labels.ts";

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
	});
	assert.match(bottom!, /^── \u{F035B} gpt-5\.6 \u{F0875} high ─+$/u);
	assert.equal(bottom!.length, WIDTH);
});

test("bottom border: undefined when the label does not fit", () => {
	const bottom = buildBottomBorder(10, {
		modelId: "gpt-5.6-sol-fast",
		effort: "xhigh",
	});
	assert.equal(bottom, undefined);
});