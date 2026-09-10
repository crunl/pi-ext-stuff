// Static/local preparation only. Never imports/initializes SRT or probes sockets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  context,
  copyPrograms,
  hash,
  inventory,
  options,
  owned,
  verifyPackage,
} from "./artifacts.mjs";

const { root, selection } = options();
assert.equal(
  selection,
  "isolated",
  "prepare only creates isolated packages; use verify for installed",
);
const ctx = context(root, selection, true);
// Resolve the *unpatched* pnpm store copy. The project's node_modules link
// points at the patched snapshot; preparing from that copy cannot satisfy
// provenance originals (and NETWORK_MODES.md must be absent).
const pristineRelative = path.join(
  "node_modules/.pnpm",
  "@anthropic-ai+sandbox-runtime@0.0.74",
  "node_modules/@anthropic-ai/sandbox-runtime",
);
const source = fs.realpathSync(path.join(ctx.repo, pristineRelative));
assert.ok(
  !source.includes("_patch_hash="),
  `prepare requires the unpatched store copy at ${pristineRelative}; got ${source}`,
);
assert.equal(hash(path.join(source, "package.json")), ctx.provenance.packageJsonSha256);
assert.equal(hash(path.join(source, "LICENSE")), ctx.provenance.licenseSha256);
for (const file of ctx.provenance.files) {
  const original = path.join(source, file.path);
  if (file.originalSha256 === null)
    assert.equal(fs.existsSync(original), false, `pristine input must be absent: ${file.path}`);
  else assert.equal(hash(original), file.originalSha256, `pristine input: ${file.path}`);
}
const original = inventory(source);
if (fs.existsSync(ctx.packagePath)) {
  owned(ctx.packagePath, true);
  fs.rmSync(ctx.packagePath, { recursive: true, force: true });
}
fs.cpSync(source, ctx.packagePath, { recursive: true });
const applied = spawnSync(
  "/usr/bin/patch",
  [
    "-p1",
    "-t",
    "-N",
    "-i",
    path.join(ctx.repo, "patches/anthropic-ai__sandbox-runtime@0.0.74.patch"),
  ],
  {
    cwd: ctx.packagePath,
    encoding: "utf8",
    maxBuffer: 65536,
    env: { PATH: "/usr/bin:/bin", HOME: ctx.root, LANG: "C", LC_ALL: "C" },
  },
);
assert.equal(applied.error, undefined);
assert.equal(applied.status, 0, applied.stdout + applied.stderr);
fs.symlinkSync(
  path.dirname(path.dirname(source)),
  path.join(ctx.packagePath, "node_modules"),
  "dir",
);
verifyPackage(ctx);
assert.deepEqual(inventory(source), original, "installed package unchanged");
copyPrograms(ctx);
fs.copyFileSync(
  path.join(ctx.root, "public-api-types.mts.txt"),
  path.join(ctx.root, "public-api-types.mts"),
);
process.stdout.write(
  `PASS: complete isolated package and canonical programs verified at ${ctx.root}; no native execution\n`,
);
