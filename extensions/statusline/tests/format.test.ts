import assert from "node:assert/strict";
import test from "node:test";
import { LSP_STATUS_KEY, partitionLspStatus } from "../src/format.ts";

test("extracts the pi-lens LSP entry, keeping the rest in order", () => {
	const { lsp, rest } = partitionLspStatus([
		["other", "Indexing"],
		[LSP_STATUS_KEY, "LSP Inactive"],
		["pi-permissions", "Auto"],
	]);
	assert.equal(lsp, "LSP Inactive");
	assert.deepEqual(rest, [
		["other", "Indexing"],
		["pi-permissions", "Auto"],
	]);
});

test("returns undefined LSP when no pi-lens entry is present", () => {
	const { lsp, rest } = partitionLspStatus([["other", "Indexing"]]);
	assert.equal(lsp, undefined);
	assert.deepEqual(rest, [["other", "Indexing"]]);
});

test("flattens newlines in the LSP text to keep the footer one line", () => {
	const { lsp } = partitionLspStatus([
		[LSP_STATUS_KEY, "LSP Active: a\nLSP Failed: b"],
	]);
	assert.equal(lsp, "LSP Active: a LSP Failed: b");
});
