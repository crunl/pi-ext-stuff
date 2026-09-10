// Static filesystem tamper regressions. Never imports SRT or executes fixture bytes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  context,
  copyPrograms,
  hash,
  inventory,
  options,
  owned,
  verifyCopies,
  verifyPackage,
} from "./artifacts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const marker = path.join(here, ".srt-network-mode-owner.json");
let canonical = here;
if (fs.existsSync(marker)) {
  owned(marker);
  canonical = path.join(JSON.parse(fs.readFileSync(marker)).repo, "patches/srt-network-mode");
}
const provenance = JSON.parse(fs.readFileSync(path.join(canonical, "provenance.json")));
const template = fs.readFileSync(new URL("./pnpm-12.3.4-self-bin.sh.txt", import.meta.url), "utf8");
const installed = { installed: true };

const base = process.env.SRT_ARTIFACT_TEST_ROOT;
assert.ok(base && path.isAbsolute(base), "SRT_ARTIFACT_TEST_ROOT must name owned scratch");
owned(base, true);
function fixture(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, "integrity-")));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("nested node_modules cannot hide package import-shadowing bytes", () =>
  fixture((root) => {
    for (const parent of ["dist", "vendor/deeper"]) {
      const nested = path.join(root, parent, "node_modules");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "never-imported.txt"), "synthetic tamper");
      assert.throws(() => inventory(root), /unexpected node_modules/);
      assert.throws(() => inventory(root, undefined, installed), /unexpected node_modules/);
      fs.rmSync(path.join(root, parent.split("/")[0]), { recursive: true });
    }
  }));

test("only an explicitly selected exact root dependency symlink is excluded", () =>
  fixture((root) => {
    const pkg = path.join(root, "package");
    const dependencies = path.join(root, "dependencies");
    fs.mkdirSync(pkg);
    fs.mkdirSync(dependencies);
    const link = path.join(pkg, "node_modules");
    fs.symlinkSync(dependencies, link, "dir");
    assert.throws(() => inventory(pkg), /unexpected node_modules/);
    assert.deepEqual(inventory(pkg, dependencies), {});
    assert.throws(() => inventory(pkg, undefined, installed));
    assert.throws(() => inventory(pkg, root), /exact existing dependency directory/);
    fs.unlinkSync(link);
    fs.mkdirSync(link);
    assert.throws(() => inventory(pkg, dependencies), /root dependencies must be a symlink/);
  }));

function selfBin(root) {
  const store = path.join(root, "node_modules/.pnpm");
  const dependencies = path.join(
    store,
    `@anthropic-ai+sandbox-runtime@0.0.74_patch_hash=${provenance.patchSha256}`,
    "node_modules",
  );
  const pkg = path.join(dependencies, "@anthropic-ai/sandbox-runtime");
  const modules = path.join(pkg, "node_modules");
  const bin = path.join(modules, ".bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(store, "node_modules"));
  fs.mkdirSync(path.join(pkg, "dist"));
  fs.writeFileSync(path.join(pkg, "dist/cli.js"), "never execute synthetic CLI\n");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: provenance.name, version: provenance.version }),
  );
  const shim = path.join(bin, "srt");
  const body = template
    .replaceAll(
      "{{NODE_PATH}}",
      [modules, dependencies, path.join(store, "node_modules")].join(":"),
    )
    .replaceAll("{{TARGET}}", path.join(pkg, "dist/cli.js"));
  fs.writeFileSync(shim, body, { mode: 0o755 });
  for (const p of [modules, bin]) fs.chmodSync(p, 0o755);
  const packageFiles = Object.fromEntries(
    ["dist/cli.js", "package.json"].map((name) => [name, hash(path.join(pkg, name))]),
  );
  const ctx = { selection: "installed", packagePath: pkg, provenance: { packageFiles } };
  return { pkg, modules, bin, shim, body, ctx, packageFiles };
}

test("exact pnpm 12 self-bin is installed-only, including installed verifyPackage call path", () =>
  fixture((root) => {
    const f = selfBin(root);
    assert.throws(() => inventory(f.pkg), /unexpected node_modules/);
    assert.deepEqual(inventory(f.pkg, undefined, installed), f.packageFiles);
    verifyPackage(f.ctx);
    fs.rmSync(f.modules, { recursive: true });
    assert.deepEqual(inventory(f.pkg, undefined, installed), f.packageFiles); // pnpm 11 absence
    verifyPackage(f.ctx);
  }));

for (const [name, mutate] of [
  ["body", (f) => fs.appendFileSync(f.shim, "# tamper\n")],
  [
    "relative target",
    (f) => fs.writeFileSync(f.shim, f.body.replaceAll("../../dist/cli.js", "../../dist/index.js")),
  ],
  [
    "absolute target",
    (f) =>
      fs.writeFileSync(f.shim, f.body.replace("# cmd-shim-target=", "# cmd-shim-target=/wrong")),
  ],
  [
    "NODE_PATH",
    (f) =>
      fs.writeFileSync(f.shim, f.body.replace('export NODE_PATH="', 'export NODE_PATH="/wrong:')),
  ],
  ["dependency", (f) => fs.mkdirSync(path.join(f.modules, "shadow"))],
  ["extra bin", (f) => fs.writeFileSync(path.join(f.bin, "other"), "tamper")],
  ["node", (f) => fs.writeFileSync(path.join(f.bin, "node"), "tamper")],
  ["node.exe", (f) => fs.writeFileSync(path.join(f.bin, "node.exe"), "tamper")],
  ["missing shim", (f) => fs.unlinkSync(f.shim)],
  ["missing bin", (f) => fs.rmSync(f.bin, { recursive: true })],
  [
    "package name",
    (f) =>
      fs.writeFileSync(
        path.join(f.pkg, "package.json"),
        JSON.stringify({ name: "other", version: "0.0.74" }),
      ),
  ],
  [
    "package version",
    (f) =>
      fs.writeFileSync(
        path.join(f.pkg, "package.json"),
        JSON.stringify({ name: provenance.name, version: "0.0.75" }),
      ),
  ],
  ["nested node_modules", (f) => fs.mkdirSync(path.join(f.pkg, "dist/node_modules"))],
  ["upstream bytes", (f) => fs.appendFileSync(path.join(f.pkg, "dist/cli.js"), "tamper")],
  ...["modules", "bin", "shim"].flatMap((key) => [
    [
      `${key} symlink`,
      (f) => {
        const target = path.join(rootOf(f), `saved-${key}`);
        fs.renameSync(f[key], target);
        fs.symlinkSync(target, f[key]);
      },
    ],
    [`${key} permissions`, (f) => fs.chmodSync(f[key], 0o777)],
  ]),
]) {
  test(`installed verification rejects ${name}`, () =>
    fixture((root) => {
      const f = selfBin(root);
      mutate(f);
      assert.throws(() => verifyPackage(f.ctx));
    }));
}
function rootOf(f) {
  return f.pkg.split("/node_modules/.pnpm/")[0];
}

for (const key of ["modules", "bin", "shim"]) {
  test(`installed verification rejects ${key} ownership`, (t) =>
    fixture((root) => {
      const f = selfBin(root);
      const lstat = fs.lstatSync;
      const mocked = t.mock.method(fs, "lstatSync", (file, ...args) => {
        const stat = lstat(file, ...args);
        if (file === f[key]) Object.defineProperty(stat, "uid", { value: process.getuid() + 1 });
        return stat;
      });
      try {
        assert.throws(() => verifyPackage(f.ctx), /ownership/);
      } finally {
        mocked.mock.restore();
      }
    }));
}

test("unsupported layout, version and shell-escaping paths fail closed", () =>
  fixture((root) => {
    for (const location of [
      "space path",
      "dollar$path",
      "colon:path",
      'quote"path',
      "back`tick",
      "back\\slash",
    ]) {
      const f = selfBin(path.join(root, location));
      assert.throws(() => inventory(f.pkg, undefined, installed), /unsupported/);
    }
    const misplaced = selfBin(path.join(root, "misplaced"));
    const standalone = path.join(root, "package");
    fs.renameSync(misplaced.pkg, standalone);
    assert.throws(() => inventory(standalone, undefined, installed), /unsupported/);
    const f = selfBin(path.join(root, "ordinary"));
    const wrong = f.pkg.replace("@0.0.74_patch_hash=", "@0.0.75_patch_hash=");
    fs.renameSync(
      path.dirname(path.dirname(path.dirname(f.pkg))),
      path.dirname(path.dirname(path.dirname(wrong))),
    );
    assert.throws(() => inventory(wrong, undefined, installed), /unsupported/);
  }));

test("canonical copies include the pinned template; copied verifier rejects template tamper", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, "integrity-copy-")));
  try {
    const ctx = context(path.join(root, "copies"), "installed", true);
    assert.equal(
      ctx.packagePath,
      fs.realpathSync(path.join(ctx.repo, "node_modules/@anthropic-ai/sandbox-runtime")),
    );
    copyPrograms(ctx);
    const copied = await import(pathToFileURL(path.join(ctx.root, "artifacts.mjs")));
    const f = selfBin(root);
    copied.verifyPackage(f.ctx);
    assert.deepEqual(copied.inventory(f.pkg, undefined, installed), f.packageFiles);
    const templateCopy = path.join(ctx.root, "pnpm-12.3.4-self-bin.sh.txt");
    fs.appendFileSync(templateCopy, "tamper\n");
    assert.throws(() => verifyCopies(ctx), /runnable copy/);
    assert.throws(
      () => copied.inventory(f.pkg, undefined, installed),
      /canonical self-bin template/,
    );
    copyPrograms(ctx);
    fs.appendFileSync(path.join(ctx.root, "artifacts.mjs"), "// tamper\n");
    assert.throws(() => verifyCopies(ctx), /runnable copy/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installed option cannot weaken exact isolated links or package selection", () =>
  fixture((root) => {
    const f = selfBin(root);
    assert.throws(() => inventory(f.pkg, root, installed), /mutually exclusive/);
    for (const selection of ["stage", "other", undefined]) {
      assert.throws(() => verifyPackage({ ...f.ctx, selection }), /package selection/);
      assert.throws(() => options(["--root", root, "--package", selection]));
    }
  }));
