import assert from "node:assert/strict";
import test from "node:test";
import { formatCwd, isHiddenExtensionStatus } from "../src/format.ts";

test("hides the pi-lens LSP status", () => {
	assert.equal(isHiddenExtensionStatus("pi-lens-lsp"), true);
});

test("keeps other extension statuses", () => {
	assert.equal(isHiddenExtensionStatus("other"), false);
	assert.equal(isHiddenExtensionStatus("pi-safety"), false);
	assert.equal(isHiddenExtensionStatus(""), false);
});

test("formatCwd shows only the leaf folder name", () => {
	assert.equal(
		formatCwd("/Users/x1a2h1/workspace/tsnjs/pi-ext-stuff", "/Users/x1a2h1"),
		"pi-ext-stuff",
	);
	assert.equal(formatCwd("/a/b/c", undefined), "c");
});

test("formatCwd keeps ~ for the home directory itself", () => {
	assert.equal(formatCwd("/Users/x1a2h1", "/Users/x1a2h1"), "~");
});

test("formatCwd handles root and trailing separators", () => {
	assert.equal(formatCwd("/", undefined), "/");
	assert.equal(formatCwd("/a/b/", undefined), "b");
});
