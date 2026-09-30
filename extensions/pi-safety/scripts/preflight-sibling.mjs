#!/usr/bin/env node
// Preflight for the sibling pi-core checkout that typecheck/test follow into.
// Does not pin a SHA; reports the sibling revision and fails closed when the
// checkout is absent, not a git repo, or has a dirty working tree.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedPkg = path.resolve(repo, "..", "..", "packages", "shared-tool-presentation");
const sharedIndex = path.join(sharedPkg, "src", "index.ts");

function fail(reason) {
  process.stderr.write(`preflight:sibling FAIL: ${reason}\n`);
  process.exitCode = 1;
}

if (!fs.existsSync(sharedPkg) || !fs.statSync(sharedPkg).isDirectory()) {
  fail(`shared package missing at ${sharedPkg}`);
} else if (!fs.existsSync(sharedIndex)) {
  fail(`shared package entry missing at ${sharedIndex}`);
} else {
  let sha = "unknown";
  let status = "";
  try {
    sha = execFileSync("git", ["-C", sharedPkg, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // The shared package is a subtree of the monorepo checkout, so a bare
    // `git status` reports the whole tree and any unrelated edit
    // would fail this preflight. Scope it to the shared package subtree.
    status = execFileSync("git", ["-C", sharedPkg, "status", "--porcelain", "--", "."], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail(
      `sibling is not a readable git checkout: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (process.exitCode !== 1) {
    const dirtyPaths = status
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.length > 0)
      // porcelain: XY<space>path — keep the two status columns, then the path
      .map((line) => line.slice(3).trim());
    const dirty = dirtyPaths.length > 0;
    process.stdout.write(`preflight:sibling OK: ${sharedPkg} @ ${sha}${dirty ? " (dirty)" : ""}\n`);
    if (dirty) {
      for (const p of dirtyPaths) {
        process.stderr.write(`preflight:sibling dirty: ${p}\n`);
      }
      fail(
        "shared package working tree is dirty; acceptance results are not attributable to this revision alone",
      );
    }
  }
}
