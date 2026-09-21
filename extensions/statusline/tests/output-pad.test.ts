import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	effectiveOutputPad,
	readOutputPadFile,
} from "../src/output-pad.ts";

function writeSettings(path: string, body: string): void {
	writeFileSync(path, body, "utf8");
}

test("readOutputPadFile treats literal 0 as 0 and other values as 1", () => {
	const dir = mkdtempSync(join(tmpdir(), "statusline-pad-"));
	const file = join(dir, "settings.json");

	writeSettings(file, JSON.stringify({ outputPad: 0 }));
	assert.equal(readOutputPadFile(file), 0);

	writeSettings(file, JSON.stringify({ outputPad: 1 }));
	assert.equal(readOutputPadFile(file), 1);

	writeSettings(file, JSON.stringify({ outputPad: 2 }));
	assert.equal(readOutputPadFile(file), 1);

	writeSettings(file, JSON.stringify({ theme: "dark" }));
	assert.equal(readOutputPadFile(file), undefined);

	writeSettings(file, "not-json");
	assert.equal(readOutputPadFile(file), undefined);

	assert.equal(readOutputPadFile(join(dir, "missing.json")), undefined);
});

test("effectiveOutputPad prefers an explicit project override", () => {
	assert.equal(effectiveOutputPad(undefined, undefined), 1);
	assert.equal(effectiveOutputPad(0, undefined), 0);
	assert.equal(effectiveOutputPad(0, 1), 1);
	assert.equal(effectiveOutputPad(1, 0), 0);
	assert.equal(effectiveOutputPad(undefined, 0), 0);
});

test("mtime changes force a re-read (spot check via utimes)", () => {
	const dir = mkdtempSync(join(tmpdir(), "statusline-pad-mtime-"));
	const file = join(dir, "settings.json");
	writeSettings(file, JSON.stringify({ outputPad: 1 }));
	assert.equal(readOutputPadFile(file), 1);

	writeSettings(file, JSON.stringify({ outputPad: 0 }));
	// Ensure a distinct mtime even on coarse filesystems.
	const past = new Date(Date.now() - 5_000);
	utimesSync(file, past, past);
	assert.equal(readOutputPadFile(file), 0);
});

test("project settings directory layout matches Pi CONFIG_DIR_NAME", () => {
	const cwd = mkdtempSync(join(tmpdir(), "statusline-pad-proj-"));
	const projectDir = join(cwd, ".pi");
	mkdirSync(projectDir, { recursive: true });
	const projectFile = join(projectDir, "settings.json");
	writeSettings(projectFile, JSON.stringify({ outputPad: 0 }));
	assert.equal(readOutputPadFile(projectFile), 0);
});
