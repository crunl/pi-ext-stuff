// Static verification by default. --run-native is a separate parent-reviewed action.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { context, copyPrograms, options, verifyCopies, verifyPackage } from "./artifacts.mjs";

const args = process.argv.slice(2);
const run = args.at(-1) === "--run-native";
if (run) args.pop();
const { root, selection } = options(args);
const existed = fs.existsSync(root);
const ctx = context(root, selection, selection === "installed");
if (selection === "installed" && !existed) copyPrograms(ctx);
verifyCopies(ctx);
verifyPackage(ctx);
process.stdout.write(`PASS: canonical/copy digests and ${selection} pinned package verified\n`);
if (run) {
  assert.equal(process.platform, "darwin", "native gate is macOS-only");
  process.argv = [process.execPath, path.join(ctx.root, "network-mode-harness.mjs"), ...args];
  await import(pathToFileURL(process.argv[1]).href);
}
