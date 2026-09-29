import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("statusline has zero static imports from pi-core", () => {
	const srcDir = path.resolve(import.meta.dirname, "../src");
	const files = fs.readdirSync(srcDir, { recursive: true })
		.filter((f): f is string => typeof f === "string" && f.endsWith(".ts"));

	for (const file of files) {
		const fullPath = path.join(srcDir, file);
		const content = fs.readFileSync(fullPath, "utf-8");
		assert.ok(
			!content.includes("pi-core"),
			`Found reference to 'pi-core' in ${file}; statusline should be decoupled from pi-core.`,
		);
	}
});
