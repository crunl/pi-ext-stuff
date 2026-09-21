import assert from "node:assert/strict";
import test from "node:test";
import { isHiddenExtensionStatus } from "../src/format.ts";

test("hides the pi-lens LSP status", () => {
	assert.equal(isHiddenExtensionStatus("pi-lens-lsp"), true);
});

test("keeps other extension statuses", () => {
	assert.equal(isHiddenExtensionStatus("other"), false);
	assert.equal(isHiddenExtensionStatus("pi-safety"), false);
	assert.equal(isHiddenExtensionStatus(""), false);
});
