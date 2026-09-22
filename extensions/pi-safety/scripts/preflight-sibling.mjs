#!/usr/bin/env node
// Preflight for the sibling pi-core checkout that typecheck/test follow into.
// Does not pin a SHA; reports the sibling revision and fails closed when the
// checkout is absent, not a git repo, or has a dirty working tree.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sibling = path.resolve(repo, "..", "pi-core");
const standalone = path.join(sibling, "standalone.ts");

function fail(reason) {
  process.stderr.write(`preflight:sibling FAIL: ${reason}\n`);
  process.exitCode = 1;
}

if (!fs.existsSync(sibling) || !fs.statSync(sibling).isDirectory()) {
  fail(`sibling checkout missing at ${sibling}`);
} else if (!fs.existsSync(standalone)) {
  fail(`sibling entry missing at ${standalone}`);
} else {
  let sha = "unknown";
  let status = "";
  try {
    sha = execFileSync("git", ["-C", sibling, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // The sibling is a subtree of the monorepo checkout, so a bare
    // `git status` reports the whole tree and any unrelated extension edit
    // would fail this preflight. Scope it to the sibling subtree.
    status = execFileSync("git", ["-C", sibling, "status", "--porcelain", "--", "."], {
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
    process.stdout.write(`preflight:sibling OK: ${sibling} @ ${sha}${dirty ? " (dirty)" : ""}\n`);
    if (dirty) {
      for (const p of dirtyPaths) {
        process.stderr.write(`preflight:sibling dirty: ${p}\n`);
      }
      fail(
        "sibling working tree is dirty; acceptance results are not attributable to this revision alone",
      );
    }
  }
}
