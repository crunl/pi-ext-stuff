// Verification helpers only: no SRT import, initialization, processes or network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const markerName = ".srt-network-mode-owner.json";
export const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export function owned(file, directory = false) {
  const stat = fs.lstatSync(file);
  assert.equal(stat.uid, process.getuid(), `ownership: ${file}`);
  assert.equal(stat.isSymbolicLink(), false, `refuse symlink: ${file}`);
  assert.equal(directory ? stat.isDirectory() : stat.isFile(), true, `file kind: ${file}`);
}
// Only the observed pnpm 12.3.4 POSIX self-bin, never a dependency exclusion.
function verifySelfBin(directory) {
  assert.ok(path.isAbsolute(directory), "unsupported self-bin layout: absolute path required");
  const pkg = fs.realpathSync(directory);
  // No shell quoting guesses: all substituted bytes must be literal shell-safe paths.
  assert.match(pkg, /^\/[A-Za-z0-9_./@+=-]+$/, "unsupported self-bin path escaping");
  let canonical = here;
  const marker = path.join(here, markerName);
  if (fs.existsSync(marker)) {
    owned(marker);
    canonical = path.join(
      JSON.parse(fs.readFileSync(marker, "utf8")).repo,
      "patches/srt-network-mode",
    );
  }
  const provenanceFile = path.join(canonical, "provenance.json");
  owned(provenanceFile);
  const provenance = JSON.parse(fs.readFileSync(provenanceFile, "utf8"));
  assert.match(provenance.patchSha256, /^[a-f0-9]{64}$/, "unsupported patch hash shape");
  const dependencies = path.dirname(path.dirname(pkg));
  const snapshot = path.dirname(dependencies);
  const store = path.dirname(snapshot);
  assert.equal(path.basename(store), ".pnpm", "unsupported virtual-store layout");
  assert.equal(path.basename(path.dirname(store)), "node_modules", "unsupported modules layout");
  assert.equal(
    path.basename(snapshot),
    `@anthropic-ai+sandbox-runtime@0.0.74_patch_hash=${provenance.patchSha256}`,
    "unsupported self-bin package/version/patch layout",
  );
  assert.equal(
    pkg,
    path.join(snapshot, "node_modules/@anthropic-ai/sandbox-runtime"),
    "unsupported package layout",
  );
  for (const dir of [
    path.dirname(store),
    store,
    snapshot,
    dependencies,
    path.dirname(pkg),
    pkg,
    path.join(store, "node_modules"),
  ])
    owned(dir, true);
  const modules = path.join(pkg, "node_modules");
  const bin = path.join(modules, ".bin");
  const shim = path.join(bin, "srt");
  for (const [file, directory] of [
    [modules, true],
    [bin, true],
    [shim, false],
  ]) {
    owned(file, directory);
    assert.equal(fs.lstatSync(file).mode & 0o7777, 0o755, `self-bin permissions: ${file}`);
  }
  assert.deepEqual(fs.readdirSync(modules), [".bin"], "self-bin modules entries");
  assert.deepEqual(fs.readdirSync(bin), ["srt"], "self-bin bin entries");
  const templateName = "pnpm-12.3.4-self-bin.sh.txt";
  const templateFile = path.join(here, templateName);
  owned(templateFile);
  assert.equal(
    hash(templateFile),
    provenance.programs[templateName],
    "canonical self-bin template",
  );
  const expected = fs
    .readFileSync(templateFile, "utf8")
    .replaceAll(
      "{{NODE_PATH}}",
      [modules, dependencies, path.join(store, "node_modules")].join(":"),
    )
    .replaceAll("{{TARGET}}", path.join(pkg, "dist/cli.js"));
  assert.deepEqual(
    fs.readFileSync(shim),
    Buffer.from(expected),
    "complete pnpm 12.3.4 self-bin body/target",
  );
}
export function inventory(directory, rootDependencies, { installed = false } = {}) {
  assert.equal(typeof installed, "boolean", "installed inventory option must be boolean");
  assert.ok(
    !installed || rootDependencies === undefined,
    "installed and isolated dependencies are mutually exclusive",
  );
  const result = {};
  function visit(relative = "") {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      const file = path.join(directory, name);
      if (entry.name === "node_modules") {
        assert.ok(
          relative === "" && (rootDependencies !== undefined || installed),
          `unexpected node_modules: ${name}`,
        );
        if (installed) {
          verifySelfBin(directory);
          continue;
        }
        const stat = fs.lstatSync(file);
        assert.equal(stat.isSymbolicLink(), true, "root dependencies must be a symlink");
        assert.equal(stat.uid, process.getuid(), "root dependency link ownership");
        assert.equal(
          fs.realpathSync(file),
          rootDependencies,
          "exact existing dependency directory",
        );
        owned(rootDependencies, true);
        continue;
      }
      if (entry.isDirectory()) {
        owned(file, true);
        visit(name);
      } else {
        owned(file);
        result[name] = hash(file);
      }
    }
  }
  owned(directory, true);
  visit();
  return result;
}
export function context(directory, selection = "isolated", create = false) {
  let root = directory;
  assert.ok(path.isAbsolute(root), "absolute owned output root required");
  assert.ok(
    ["isolated", "installed"].includes(selection),
    "package selection must be isolated or installed",
  );
  // Copied helpers recover the repository identity from the owned workspace marker.
  const copiedMarker = path.join(here, markerName);
  let repo = fs.realpathSync(path.join(here, "../.."));
  if (fs.existsSync(copiedMarker)) {
    owned(copiedMarker);
    repo = JSON.parse(fs.readFileSync(copiedMarker, "utf8")).repo;
  }
  const canonical = path.join(repo, "patches/srt-network-mode");
  owned(canonical, true);
  owned(path.join(canonical, "provenance.json"));
  const provenance = JSON.parse(fs.readFileSync(path.join(canonical, "provenance.json"), "utf8"));
  if (!fs.existsSync(root)) {
    assert.equal(create, true, "prepare the owned root first");
    fs.mkdirSync(root, { mode: 0o700 });
    fs.writeFileSync(
      path.join(root, markerName),
      JSON.stringify({ uid: process.getuid(), repo, patch: provenance.patchSha256 }),
    );
  }
  owned(root, true);
  root = fs.realpathSync(root);
  const marker = path.join(root, markerName);
  owned(marker);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(marker, "utf8")),
    { uid: process.getuid(), repo, patch: provenance.patchSha256 },
    "owned workspace identity; use a fresh root for a new patch",
  );
  owned(path.join(repo, "patches/anthropic-ai__sandbox-runtime@0.0.74.patch"));
  assert.equal(
    hash(path.join(repo, "patches/anthropic-ai__sandbox-runtime@0.0.74.patch")),
    provenance.patchSha256,
    "patch digest",
  );
  for (const [name, digest] of Object.entries(provenance.programs)) {
    owned(path.join(canonical, name));
    assert.equal(hash(path.join(canonical, name)), digest, `canonical program: ${name}`);
  }
  const packagePath =
    selection === "isolated"
      ? path.join(root, "package")
      : fs.realpathSync(path.join(repo, "node_modules/@anthropic-ai/sandbox-runtime"));
  return { root, repo, canonical, provenance, packagePath, selection };
}
export function copyPrograms(ctx) {
  for (const name of Object.keys(ctx.provenance.programs)) {
    const target = path.join(ctx.root, name);
    if (fs.existsSync(target)) owned(target);
    fs.copyFileSync(path.join(ctx.canonical, name), target);
  }
  verifyCopies(ctx);
}
export function verifyCopies(ctx) {
  for (const [name, digest] of Object.entries(ctx.provenance.programs)) {
    owned(path.join(ctx.root, name));
    assert.equal(hash(path.join(ctx.root, name)), digest, `runnable copy: ${name}`);
  }
}
export function diffInventories(actual, expected) {
  const paths = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  const diverged = [];
  for (const file of [...paths].sort()) {
    const a = actual[file];
    const e = expected[file];
    if (a === e) continue;
    diverged.push({
      path: file,
      actual: a ?? null,
      expected: e ?? null,
      kind: a === undefined ? "missing" : e === undefined ? "extra" : "digest",
    });
  }
  return diverged;
}

export function verifyPackage(ctx) {
  assert.ok(
    ["isolated", "installed"].includes(ctx.selection),
    "package selection must be isolated or installed",
  );
  let rootDependencies;
  if (ctx.selection === "isolated") {
    // Isolated packages are prepared from the unpatched store copy; their
    // dependency link must resolve to that same store sibling directory.
    const pristine = fs.realpathSync(
      path.join(
        ctx.repo,
        "node_modules/.pnpm",
        "@anthropic-ai+sandbox-runtime@0.0.74",
        "node_modules/@anthropic-ai/sandbox-runtime",
      ),
    );
    rootDependencies = path.dirname(path.dirname(pristine));
    // Isolated verification still requires the exact prepared dependency link.
    // Installed verification permits only the separately validated generated self-bin.
    assert.equal(
      fs.lstatSync(path.join(ctx.packagePath, "node_modules")).isSymbolicLink(),
      true,
      "isolated dependencies must be the prepared link",
    );
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ctx.packagePath, "package.json"), "utf8"));
  assert.equal(pkg.name, "@anthropic-ai/sandbox-runtime");
  assert.equal(pkg.version, "0.0.74");
  const actual = inventory(ctx.packagePath, rootDependencies, {
    installed: ctx.selection === "installed",
  });
  const diverged = diffInventories(actual, ctx.provenance.packageFiles);
  if (diverged.length > 0) {
    const detail = diverged
      .map((entry) => `${entry.path}: expected ${entry.expected}, actual ${entry.actual} (${entry.kind})`)
      .join("; ");
    const hint =
      ctx.selection === "installed" &&
      diverged.every((entry) => entry.kind === "digest")
        ? " If only patched docs diverge with a double-applied hunk, reinstall from the lockfile (or re-apply the patch once) rather than treating this as a lost patch."
        : "";
    throw new assert.AssertionError({
      message: `pinned patched package identity mismatch (${diverged.length} path(s)): ${detail}.${hint}`,
      actual: diverged,
      expected: [],
      operator: "deepEqual",
    });
  }
}
export function options(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 4, "usage: --root <owned-output-dir> --package isolated|installed");
  assert.equal(argv[0], "--root");
  assert.equal(argv[2], "--package");
  assert.ok(
    ["isolated", "installed"].includes(argv[3]),
    "package selection must be isolated or installed",
  );
  return { root: argv[1], selection: argv[3] };
}
