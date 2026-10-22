import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { createDenialCircuit } from "../src/denial-circuit.ts";
import { GUARDIAN_DENIAL_WINDOW_SIZE } from "../src/guardian-policy.ts";
import { PI_OWNED_TOOL_NAMES } from "../src/register-support.ts";

/** Extensions a layer bucket has to account for: every module the loader can reach. */
const SOURCE_EXTENSIONS = [".ts", ".mts", ".mjs"] as const;

/**
 * Every scan below wants every module the loader can reach, so that is the
 * default: a `.ts`-only default is what used to hide the plain-module half of
 * the worker seam from a scan that was written to find it. A caller that really
 * wants one extension has to say so.
 */
async function collectModules(
  dir: string,
  extensions: readonly string[] = SOURCE_EXTENSIONS,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectModules(path, extensions)));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) files.push(path);
  }
  return files;
}

describe("structure invariants named by the cohesion review", () => {
  it("legacy safe-command whitelist is removed from production", async () => {
    const files = await collectModules("src");
    expect(files.some((file) => file.endsWith("permissions/safe-commands.ts"))).toBe(false);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (text.includes("permissions/safe-commands")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("resolves the grammar wasm lazily, never at module load", async () => {
    const source = await readFile("src/tree-sitter/shell-backend.ts", "utf8");
    // A top-level resolve() runs at import time: an unresolvable package
    // would throw before register.ts (a static importer) finishes loading,
    // taking the whole extension and V1 permissions down with it. Resolution
    // must therefore stay inside a function body, never at column zero.
    expect(source).not.toContain("TREE_SITTER_BASH_WASM_PATH");
    const topLevelResolve = source
      .split("\n")
      .filter((line) => line.includes("resolve(") && !/^\s/.test(line));
    expect(topLevelResolve).toEqual([]);
  });

  it("RegisterExtensionOptions has no filtering-proxy factory seam", async () => {
    const source = await readFile("src/register.ts", "utf8");
    expect(source).toMatch(/export interface RegisterExtensionOptions/);
    expect(source).not.toMatch(/filteringProxyFactory/);
    expect(source).not.toMatch(/localProxyPorts/);
  });

  it("register owns no legacy orchestration modules", async () => {
    const source = await readFile("src/register.ts", "utf8");
    for (const module of [
      "auto-approval-ledger",
      "auto-policy",
      "enforced-tool",
      "grant-ledger",
      "sticky-permission-world",
    ]) {
      expect(source).not.toContain(module);
    }
  });

  it("uses one SRT-owned executor seam", async () => {
    const source = await readFile("src/sandbox/srt-enforcer.ts", "utf8");
    expect(source).toContain("@anthropic-ai/sandbox-runtime");
    expect(source).toContain("wrapWithSandboxArgv");
    expect(source).toMatch(/shell:\s*false/);
    expect(source).toMatch(/detached:\s*true/);
  });

  it("does not retain removed backend or filtering modules", async () => {
    // sandbox.ts and sandbox-guardian.ts are the two halves of what used to be
    // one module: the trusted reviewer side moved out, and the guard has to
    // follow it. Reading only the half the implementation left behind would let
    // every removed name return to the half nothing here reads.
    const agentSideSources = [
      await readFile("src/sandbox.ts", "utf8"),
      await readFile("src/sandbox-guardian.ts", "utf8"),
    ];
    const srtSource = await readFile("src/sandbox/srt-enforcer.ts", "utf8");
    for (const source of [...agentSideSources, srtSource]) {
      expect(source).not.toContain("httpProxyPort");
      expect(source).not.toContain("socksProxyPort");
      expect(source).not.toContain("upstream_proxy");
    }
    for (const source of agentSideSources) {
      expect(source).not.toContain("feasible-allow");
    }
    expect(srtSource).not.toContain("nono");
  });

  it("the untrusted sandbox seam publishes no reviewer-side policy name", async () => {
    // The split is only real if the agent tool side stops being a public seam
    // for the reviewer's profile. A re-export here costs nothing at runtime and
    // quietly restores the edge, so the names are pinned absent by name rather
    // than trusted to stay gone. Owning module: sandbox-policy.ts.
    const source = await readFile("src/sandbox.ts", "utf8");
    for (const name of [
      "GuardianEvidenceScope",
      "copyGuardianEvidenceScope",
      "createGuardianEvidencePolicyCeiling",
      "createGuardianEvidenceScope",
      "createGuardianReadOnlySandboxConfig",
    ]) {
      expect(source).not.toContain(name);
    }
  });
});

interface ModuleEdge {
  /** Repo-relative importer, e.g. "src/register.ts". */
  from: string;
  /** Raw specifier exactly as written. */
  target: string;
  /** True for `import type` (single-line) or a block opened by `import type`. */
  isType: boolean;
}

function parseModuleEdges(repoFile: string, text: string): ModuleEdge[] {
  // Line-anchored on purpose: naive whole-file import regexes both
  // catastrophic-backtrack on this tree and false-positive on the
  // `require("node:child_process")` string inside the RUN_RESOLVED_RG_HELPER
  // template literal in guardian-tools.ts (those lines open with `const`).
  const edges: ModuleEdge[] = [];
  let inBlock = false;
  let blockIsType = false;
  for (const line of text.split("\n")) {
    if (!inBlock) {
      const open = line.match(/^\s*(import|export)\s+(type\s+)?/);
      if (!open) continue;
      const single = line.match(/\bfrom\s+"([^"]+)"\s*;?\s*$/);
      if (single) {
        edges.push({ from: repoFile, target: single[1], isType: Boolean(open[2]) });
        continue;
      }
      if (open[1] === "import") {
        inBlock = true;
        blockIsType = Boolean(open[2]);
      }
      continue;
    }
    const close = line.match(/}\s*from\s+"([^"]+)"\s*;?\s*$/);
    if (close) {
      edges.push({ from: repoFile, target: close[1], isType: blockIsType });
      inBlock = false;
    }
  }
  return edges;
}

function resolveLocalEdge(fromFile: string, target: string): string | null {
  if (!target.startsWith(".")) return null;
  return normalize(join(dirname(fromFile), target)).replace(/\\/g, "/");
}

async function valueEdges(repoFile: string): Promise<ModuleEdge[]> {
  const text = await readFile(repoFile, "utf8");
  return parseModuleEdges(repoFile, text).filter((edge) => !edge.isType);
}

/**
 * Transitive import closure over repo-local modules. `includeType` decides
 * whether `import type` edges count: a reviewer judging reach wants only value
 * edges, a reviewer judging whether a module is genuinely cross-layer wants
 * every declared edge.
 */
async function declaredClosure(entry: string, includeType: boolean): Promise<Set<string>> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) break;
    const text = await readFile(current, "utf8");
    for (const edge of parseModuleEdges(current, text)) {
      if (edge.isType && !includeType) continue;
      const resolved = resolveLocalEdge(current, edge.target);
      if (!resolved || seen.has(resolved)) continue;
      if (!resolved.endsWith(".ts") && !resolved.endsWith(".mjs")) continue;
      if (!existsSync(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return seen;
}

/** Transitive value-import closure (type edges excluded). */
async function valueClosure(entry: string): Promise<Set<string>> {
  return declaredClosure(entry, false);
}

/**
 * The closure of a layer's entry points. This is reachability, not layer
 * membership: a module nothing imports yet is invisible here, so a closure can
 * never stand in for a bucket. It is used the other way round — as a cross-check
 * on what a layer's entry points actually pull in, against the bucket that is
 * supposed to contain it. `includeType` decides whether `import type` edges
 * count: a layer judging what it *reaches* wants value edges, a module judging
 * who *reads* it (vocabulary, config shape) wants every declared edge.
 */
async function layerClosure(entries: readonly string[], includeType = false): Promise<Set<string>> {
  const union = new Set<string>();
  for (const entry of entries) {
    for (const file of await declaredClosure(entry, includeType)) union.add(file);
  }
  return union;
}

async function valueNodeImports(repoFile: string): Promise<string[]> {
  return (await valueEdges(repoFile))
    .map((edge) => edge.target)
    .filter((target) => target.startsWith("node:"));
}

// Layer names are enforced groupings, not directories: no engine/, propose/,
// review/, enforce/, or host/ directory exists in src/. Which layer owns a
// module is a design decision, so a bucket is a literal list — but a list alone
// drifts, because it cannot mention the module nobody has written yet. What
// closes that gap is totality: every module under src/ must be claimed by
// exactly one bucket, so a module added later lands somewhere a reviewer chose
// or the suite fails. Reachability cannot do this job; only a list can.
const LAYER_NAMES = ["ENGINE", "PROPOSE", "REVIEW", "ENFORCE", "HOST", "SHARED"] as const;
type LayerName = (typeof LAYER_NAMES)[number];

const LAYER_BUCKETS: Record<LayerName, readonly string[]> = {
  /** The authorization fold. Decides; performs no I/O of its own. */
  ENGINE: [
    "src/engine.ts",
    "src/engine-clone.ts",
    "src/engine-fingerprint.ts",
    "src/denial-circuit.ts",
  ],
  /** The risk fold: request shape in, decision out. */
  PROPOSE: [
    "src/risk-policy.ts",
    "src/permission-amendment.ts",
    "src/shell-permissions.ts",
    "src/permissions/cd-normalize.ts",
    "src/permissions/dangerous-commands.ts",
    "src/permissions/git-exec-entries.ts",
    "src/permissions/git-network.ts",
    "src/permissions/paths.ts",
    "src/permissions/risk.ts",
    "src/permissions/rules.ts",
    "src/permissions/shell-ast.ts",
    "src/permissions/shell-network.ts",
    "src/permissions/shell-segment.ts",
    "src/permissions/shell-tokens.ts",
  ],
  /** The reviewer: judgment over a request, never execution of it. */
  REVIEW: [
    "src/auto-reviewer.ts",
    "src/auto-review-request.ts",
    "src/guardian-worker-client.ts",
    "src/guardian-tools.ts",
    "src/guardian-session.ts",
    "src/guardian-policy.ts",
    "src/guardian-action.ts",
    "src/guardian-transcript.ts",
    "src/guardian-model.ts",
    "src/guardian-diagnostic.ts",
    "src/guardian/metrics.ts",
    "src/guardian/errors.ts",
    "src/sandbox-guardian.ts",
  ],
  /** Enforcement: the sandbox runtime, its leases, and the isolated worker. */
  ENFORCE: [
    "src/sandbox.ts",
    "src/sandbox-lifecycle-lease.ts",
    "src/sandbox/connect-guard.ts",
    "src/sandbox/srt-coordinator.ts",
    "src/sandbox/srt-enforcer.ts",
    "src/guardian-worker.mjs",
  ],
  /** The host adapter: registration, session state, and presentation. */
  HOST: [
    "src/register.ts",
    "src/register-support.ts",
    "src/register-state.ts",
    "src/register-request-permissions.ts",
    "src/register-tool-copy.ts",
    "src/pi-safety.ts",
    "src/pi-guardian-adapters.ts",
    "src/mode-runtime.ts",
    "src/state.ts",
    "src/permission-session.ts",
    "src/permission-copy.ts",
    "src/review-presenter.ts",
    "src/review-renderer.ts",
    "src/bash-outcome.ts",
    "src/delegation.ts",
    "src/delegation-policy.ts",
    "src/network-boundary.ts",
    "src/tree-sitter/shell-backend.ts",
  ],
  /**
   * Genuinely cross-layer modules. Membership test: two or more of the layers
   * above reach it. Each is either vocabulary with no runtime output
   * (engine-types), a pure predicate over addresses and paths (policy-primitives,
   * network-host, network-domain-pattern, filesystem-policy), the config shape
   * every layer reads, or a protocol constant pair both sides of the worker seam
   * must agree on. A module one layer alone reaches belongs in that layer's
   * bucket instead — that is what keeps SHARED from becoming a dumping ground.
   */
  SHARED: [
    "src/engine-types.ts",
    "src/unknown-value.ts",
    "src/policy-primitives.ts",
    "src/request-limits.ts",
    "src/config.ts",
    "src/filesystem-policy.ts",
    "src/network-host.ts",
    "src/network-domain-pattern.ts",
    "src/sandbox-policy.ts",
    "src/permissions/residual.ts",
    "src/git-metadata.ts",
    "src/guardian-worker-limits.mjs",
    "src/guardian-worker-limits.d.mts",
  ],
};

const REACH_LAYERS = [
  "ENGINE",
  "PROPOSE",
  "REVIEW",
  "ENFORCE",
  "SHARED",
] as const satisfies readonly LayerName[];
type ReachLayer = (typeof REACH_LAYERS)[number];

/**
 * Entry points and named exceptions per layer, for the reach cross-check. HOST
 * is absent on purpose: the registration adapter is the composition root, so its
 * closure is the whole extension by design and a subset test says nothing. HOST
 * is judged by direction instead (nothing reaches up into it, and it holds
 * nothing the root never installs), which is the only rule its position makes
 * meaningful.
 */
const LAYER_REACH: Record<
  ReachLayer,
  { readonly entries: readonly string[]; readonly exceptions: readonly string[] }
> = {
  ENGINE: { entries: ["src/engine.ts"], exceptions: [] },
  PROPOSE: { entries: ["src/risk-policy.ts"], exceptions: [] },
  REVIEW: {
    entries: ["src/auto-reviewer.ts", "src/guardian-diagnostic.ts"],
    // No exceptions. The reviewer reaches the pure policy seam through
    // sandbox-policy.ts, which SHARED already sanctions; the tool side's
    // execution factories in sandbox.ts are off its closure since
    // guardian-tools.ts moved to sandbox-guardian.ts, so naming sandbox.ts here
    // would whitelist exactly the cross-trust edge the split removed.
    exceptions: [],
  },
  ENFORCE: {
    entries: [
      "src/sandbox.ts",
      "src/sandbox/srt-enforcer.ts",
      "src/sandbox/srt-coordinator.ts",
      "src/sandbox-lifecycle-lease.ts",
      "src/guardian-worker.mjs",
    ],
    exceptions: [],
  },
  SHARED: { entries: LAYER_BUCKETS.SHARED, exceptions: [] },
};

/**
 * The modules that name each layer: the ones a reader points at to say "this is
 * the Engine", and the ones each layer's own rules are anchored on. Reused from
 * the reach table so there is one list per layer, not two. HOST's seed is the
 * composition root; SHARED has none on purpose — it is not seeded by a module,
 * it is defined by a property, and that property is asserted instead.
 */
const SEED_LAYERS = [
  "ENGINE",
  "PROPOSE",
  "REVIEW",
  "ENFORCE",
  "HOST",
] as const satisfies readonly LayerName[];
type SeedLayer = (typeof SEED_LAYERS)[number];

const LAYER_SEEDS: Record<SeedLayer, readonly string[]> = {
  ENGINE: LAYER_REACH.ENGINE.entries,
  PROPOSE: LAYER_REACH.PROPOSE.entries,
  REVIEW: LAYER_REACH.REVIEW.entries,
  ENFORCE: LAYER_REACH.ENFORCE.entries,
  HOST: ["src/register.ts"],
};

describe("layer boundaries named by the import-graph review", () => {
  // Totality is the load-bearing invariant. A layer rule can only judge the
  // modules it is handed, so a module absent from every bucket is silently
  // exempt from all of them — and reachability will not notice, because a module
  // with no importers has an empty closure. Naming every module once is what
  // makes the buckets below a design statement instead of a snapshot.
  it("every src module is claimed by exactly one layer bucket", async () => {
    const modules = await collectModules("src", SOURCE_EXTENSIONS);
    const claims = new Map<string, LayerName[]>();
    for (const layer of LAYER_NAMES) {
      for (const module of LAYER_BUCKETS[layer]) {
        const owners = claims.get(module) ?? [];
        owners.push(layer);
        claims.set(module, owners);
      }
    }
    const twiceClaimed = [...claims]
      .filter(([, owners]) => owners.length > 1)
      .map(([module, owners]) => `${module} <- ${owners.join(", ")}`);
    expect(twiceClaimed).toEqual([]);
    // A bucket naming a module that no longer exists would keep the claim count
    // honest while covering nothing, so a rename has to fail here rather than
    // quietly shrink a layer.
    expect([...claims.keys()].filter((module) => !modules.includes(module)).sort()).toEqual([]);
    // The point of the whole exercise: there is nowhere for a new module to sit
    // unclaimed, so it cannot escape every rule below.
    expect(modules.filter((module) => !claims.has(module))).toEqual([]);
  });

  // A broken or emptied bucket keeps the totality assertion above green — that
  // assertion only reads the names that are there — while reducing a layer rule
  // to a no-op over almost no modules. The count has to be per layer: one number
  // summed over all six buckets stays large while individual layers are gutted,
  // so moving HOST's and ENGINE's modules into SHARED leaves a union-wide
  // comparison untouched. Each bucket must therefore exceed that layer's own
  // seed list, and must own the seeds it is named by.
  it("every bucket is strictly larger than that layer's own seed list", async () => {
    for (const layer of LAYER_NAMES) {
      expect(LAYER_BUCKETS[layer].length).toBeGreaterThan(0);
    }
    const starved: string[] = [];
    for (const layer of SEED_LAYERS) {
      const seeds = LAYER_SEEDS[layer];
      // A seed outside its own bucket would satisfy the size comparison below
      // while the module that names the layer sat somewhere else.
      for (const seed of seeds) {
        if (!LAYER_BUCKETS[layer].includes(seed)) starved.push(`${layer} does not own ${seed}`);
      }
      if (LAYER_BUCKETS[layer].length <= seeds.length) {
        starved.push(
          `${layer} claims ${LAYER_BUCKETS[layer].length}, its seeds alone are ${seeds.length}`,
        );
      }
    }
    expect(starved).toEqual([]);
  });

  // SHARED's size rule runs the other way — a cross-layer module cannot be
  // starved, only absorbed — so its own stated membership test is what gets
  // asserted: two or more layers declare it. This is the rule that keeps SHARED
  // from becoming the place a layer's modules go to escape that layer's rules,
  // which is the other half of the gutting scenario above. HOST is not counted
  // as a declarer: its closure is the whole extension, so counting it would make
  // every module pass. The one named exception is a declaration pair: the
  // compiler finds `guardian-worker-limits.d.mts` from the `.mjs` path beside it,
  // never from an import statement, so no layer can name it.
  it("every shared-vocabulary module is declared by two or more layers", async () => {
    const declaredBy = new Map<string, string[]>();
    for (const layer of REACH_LAYERS) {
      if (layer === "SHARED") continue;
      // Declared, not only reached: a config shape and a protocol constant pair
      // are shared through `import type` as often as through a value import, and
      // both count as a layer naming the module.
      for (const module of await layerClosure(LAYER_REACH[layer].entries, true)) {
        const layers = declaredBy.get(module) ?? [];
        layers.push(layer);
        declaredBy.set(module, layers);
      }
    }
    expect(
      LAYER_BUCKETS.SHARED.filter((module) => (declaredBy.get(module) ?? []).length < 2),
    ).toEqual(["src/guardian-worker-limits.d.mts"]);
  });

  // HOST was claimed, totalled and counted, and then judged by nothing: a module
  // moved into it escaped every rule its old layer imposed. The rule the buckets
  // imply is direction. Every other layer is reachable from the composition root
  // and none of them may reach back into it, or a lower layer is one edit from
  // doing registration work. The other direction matters as much: HOST is what
  // the composition root installs, so a module parked there that `register.ts`
  // never pulls in is a module hiding from every layer rule, this one included.
  it("nothing outside the host layer value-imports it, and it holds no module the root never installs", async () => {
    const upward: string[] = [];
    for (const file of await collectModules("src")) {
      const name = file.replace(/\\/g, "/");
      if (LAYER_BUCKETS.HOST.includes(name)) continue;
      for (const edge of await valueEdges(name)) {
        const resolved = resolveLocalEdge(name, edge.target);
        if (resolved !== null && LAYER_BUCKETS.HOST.includes(resolved)) {
          upward.push(`${name} -> ${resolved}`);
        }
      }
    }
    expect(upward).toEqual([]);
    const installed = await valueClosure("src/register.ts");
    expect(LAYER_BUCKETS.HOST.filter((module) => !installed.has(module))).toEqual([]);
  });

  // Reach is a cross-check, not the membership definition: the bucket says who
  // owns a module, this says a layer's entry points cannot quietly pull in a
  // module another layer owns.
  it("each layer's value closure stays inside its bucket and the shared vocabulary", async () => {
    const offenders: string[] = [];
    for (const layer of REACH_LAYERS) {
      const { entries, exceptions } = LAYER_REACH[layer];
      const allowed = new Set<string>([
        ...LAYER_BUCKETS[layer],
        ...LAYER_BUCKETS.SHARED,
        ...exceptions,
      ]);
      for (const module of await layerClosure(entries)) {
        if (!allowed.has(module)) offenders.push(`${layer} reaches ${module}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("engine value-closure performs no I/O and binds no host packages", async () => {
    const closure = await valueClosure("src/engine.ts");
    const offenders: string[] = [];
    for (const file of [...closure].sort()) {
      for (const target of await valueNodeImports(file)) {
        const family = target.slice("node:".length).split("/")[0];
        if (family === "fs" || family === "child_process" || family === "dns") {
          offenders.push(`${file} -> ${target}`);
          continue;
        }
        if (
          family === "net" &&
          file !== "src/network-host.ts" &&
          file !== "src/network-domain-pattern.ts"
        ) {
          // node:net is sanctioned only in the two named pure address-predicate
          // modules (BlockList/isIP checks, no sockets); nowhere else in the
          // authorizer closure.
          offenders.push(`${file} -> ${target}`);
        }
      }
      for (const edge of await valueEdges(file)) {
        if (
          edge.target.startsWith("@earendil-works/") ||
          edge.target === "@anthropic-ai/sandbox-runtime" ||
          edge.target === "web-tree-sitter" ||
          edge.target === "tree-sitter-bash"
        ) {
          offenders.push(`${file} -> ${edge.target}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only engine-types declares the authority-minting names", async () => {
    const declarers = new Set<string>();
    for (const file of await collectModules("src")) {
      const text = await readFile(file, "utf8");
      if (/^\s*export\s+(type|interface)\s+(CapabilityLease|AdmissionPlan)\b/m.test(text)) {
        declarers.add(file.replace(/\\/g, "/"));
      }
    }
    expect([...declarers].sort()).toEqual(["src/engine-types.ts"]);
  });

  it("propose layer never touches authority names and owns no I/O but paths.ts", async () => {
    const authorityOffenders: string[] = [];
    const ioOffenders: string[] = [];
    const grammarOffenders: string[] = [];
    for (const file of LAYER_BUCKETS.PROPOSE) {
      const text = await readFile(file, "utf8");
      // Reuse the block-aware parser: join continuation lines so a symbol split
      // across a multi-line import still matches its opener kind.
      const statements = text.split("\n").reduce<{
        current: string;
        isType: boolean;
        out: Array<{ text: string; isType: boolean }>;
      }>(
        (acc, line) => {
          if (acc.current === "") {
            const open = line.match(/^\s*import\s+(type\s+)?/);
            if (!open) return acc;
            if (/\bfrom\s+"[^"]+"\s*;?\s*$/.test(line)) {
              acc.out.push({ text: line, isType: Boolean(open[1]) });
              return acc;
            }
            return { current: line, isType: Boolean(open[1]), out: acc.out };
          }
          const next = `${acc.current}\n${line}`;
          if (/}\s*from\s+"[^"]+"\s*;?\s*$/.test(line)) {
            acc.out.push({ text: next, isType: acc.isType });
            return { current: "", isType: false, out: acc.out };
          }
          return { current: next, isType: acc.isType, out: acc.out };
        },
        { current: "", isType: false, out: [] },
      ).out;
      for (const statement of statements) {
        if (statement.isType) continue;
        if (/(CapabilityLease|RetryHandle|AdmissionPlan|InvocationExecutor)/.test(statement.text)) {
          authorityOffenders.push(file);
        }
        if (
          file !== "src/permissions/paths.ts" &&
          /from\s+"node:(fs|child_process)/.test(statement.text)
        ) {
          // paths.ts keeps canonicalize (realpath); it is the single named
          // impure member of the propose layer, not a precedent.
          ioOffenders.push(file);
        }
        if (/from\s+"(web-tree-sitter|tree-sitter-bash)"/.test(statement.text)) {
          // The tree-sitter grammar reaches the propose layer only
          // through the parser the host bridge injects
          // (installShellAstParser); a value import here would couple
          // the pure fold to the WASM runtime and the grammar package
          // the bridge owns.
          grammarOffenders.push(file);
        }
      }
    }
    expect(authorityOffenders).toEqual([]);
    expect(ioOffenders).toEqual([]);
    expect(grammarOffenders).toEqual([]);
    // This rule used to sweep every src/permissions/*.ts in by glob. The residual
    // vocabulary is the one module that glob caught but this rule must not judge:
    // the Engine, the reviewer, and the host all import it, so SHARED claims it.
    // Pin that exemption by name, so a second module cannot leave the rule the
    // same unexamined way.
    const permissionsModules = await collectModules("src/permissions");
    expect(permissionsModules.filter((module) => !LAYER_BUCKETS.PROPOSE.includes(module))).toEqual([
      "src/permissions/residual.ts",
    ]);
  });

  it("review layer never wires the host and spawns only via the worker client", async () => {
    const hostOffenders: string[] = [];
    const spawnOffenders: string[] = [];
    for (const file of LAYER_BUCKETS.REVIEW) {
      for (const edge of await valueEdges(file)) {
        const resolved = resolveLocalEdge(file, edge.target);
        // sandbox.ts (execution factories) and sandbox-policy.ts (pure seam)
        // are sanctioned review dependencies; register.ts/pi-safety.ts are not.
        if (resolved === "src/register.ts" || resolved === "src/pi-safety.ts") {
          hostOffenders.push(`${file} -> ${resolved}`);
        }
        if (resolved?.startsWith("src/sandbox/")) {
          hostOffenders.push(`${file} -> ${resolved}`);
        }
        if (edge.target === "node:child_process" && file !== "src/guardian-worker-client.ts") {
          spawnOffenders.push(file);
        }
      }
    }
    expect(hostOffenders).toEqual([]);
    expect(spawnOffenders).toEqual([]);
  });

  it("only the SRT enforcer and the isolated worker import sandbox-runtime", async () => {
    const importers = new Set<string>();
    // Every module the loader can reach, plain modules included: the worker half
    // of this seam is `.mjs`, so a scan that only looked at `.ts` would be
    // asserting about a directory it had not read.
    for (const file of await collectModules("src", SOURCE_EXTENSIONS)) {
      for (const edge of await valueEdges(file)) {
        if (edge.target === "@anthropic-ai/sandbox-runtime")
          importers.add(file.replace(/\\/g, "/"));
      }
    }
    expect([...importers].sort()).toEqual([
      "src/guardian-worker.mjs",
      "src/sandbox/srt-enforcer.ts",
    ]);
    // The authorizer reaches enforcement only through the pure projection seam.
    const closure = await valueClosure("src/engine.ts");
    const ioEnforcement = [...closure].filter(
      (file) =>
        file === "src/sandbox.ts" ||
        file.startsWith("src/sandbox/") ||
        file === "src/sandbox-lifecycle-lease.ts",
    );
    expect(ioEnforcement).toEqual([]);
  });

  it("host packages enter only through the adapter and the reviewer", async () => {
    const codingAgent = new Set<string>();
    const piAi = new Set<string>();
    const sharedPresentation = new Set<string>();
    for (const file of await collectModules("src")) {
      const name = file.replace(/\\/g, "/");
      for (const edge of await valueEdges(file)) {
        if (edge.target === "@earendil-works/pi-coding-agent") codingAgent.add(name);
        if (
          edge.target === "@earendil-works/pi-ai" ||
          edge.target === "@earendil-works/pi-ai/compat"
        ) {
          piAi.add(name);
        }
        if (edge.target === "../../../packages/shared-tool-presentation/src/index.ts") {
          sharedPresentation.add(name);
        }
      }
    }
    // Scope is per package: pi-ai/compat has its own single sanctioned importer.
    expect([...codingAgent].sort()).toEqual(["src/guardian-tools.ts", "src/register.ts"]);
    expect([...piAi].sort()).toEqual(["src/auto-reviewer.ts"]);
    expect([...sharedPresentation].sort()).toEqual(["src/register.ts"]);
  });

  it("the isolated worker imports no TypeScript and ships its limits pair", async () => {
    const worker = await readFile("src/guardian-worker.mjs", "utf8");
    const tsSpecifiers = worker
      .split("\n")
      .filter((line) => /^\s*import\s+.*\bfrom\s+"[^"]*\.ts["']/.test(line));
    expect(tsSpecifiers).toEqual([]);
    expect(existsSync("src/guardian-worker-limits.mjs")).toBe(true);
    expect(existsSync("src/guardian-worker-limits.d.mts")).toBe(true);
  });

  // The circuit-interrupted notice quotes a window size to the user, while the
  // Engine enforces options.denialWindowSize ?? its own default. Both must read
  // the same declaration, or the number shown can silently stop matching the
  // number enforced and no test would notice: register.ts and pi-safety.ts do
  // not import each other. Naming the same identifier is not enough — the two
  // modules could hold two constants of that name with different values — so
  // this compares the values the Engine and the notice actually read.
  it("the denial window the Engine enforces is the one the notice reports", async () => {
    const registration = await readFile("src/pi-safety.ts", "utf8");
    const presentation = await readFile("src/register.ts", "utf8");
    expect(registration).toMatch(/denialWindowSize:\s*GUARDIAN_DENIAL_WINDOW_SIZE/);
    expect(presentation).toMatch(/windowSize:\s*GUARDIAN_DENIAL_WINDOW_SIZE/);
    // Naming the same identifier is not enough: the two sides could each hold a
    // constant of that name with different values. So this reads the number the
    // Engine actually enforces out of the circuit, by denying more times than any
    // window holds and letting the window report its own width.
    const enforced = createDenialCircuit({
      maxConsecutiveDenials: GUARDIAN_DENIAL_WINDOW_SIZE + 10,
      maxWindowDenials: GUARDIAN_DENIAL_WINDOW_SIZE + 10,
    });
    for (let index = 0; index < GUARDIAN_DENIAL_WINDOW_SIZE + 10; index += 1) {
      enforced.recordDenial();
    }
    // After more denials than the window can hold, the survivor count is the
    // window's own width: exactly the default the Engine applies when its options
    // set no threshold. A default that drifted in either direction lands here.
    expect(enforced.readout().recentDenials).toBe(GUARDIAN_DENIAL_WINDOW_SIZE);
  });

  // The tool_call hook decides its early-return purely from PI_OWNED_TOOL_NAMES
  // (register-support.ts), while the tools are registered at separate
  // pi.registerTool call sites. Those are two independent facts, and nothing
  // else relates them: a managed tool added to one and not the other silently
  // changes which governance path it takes. Cross-check the counts and the
  // literal names so drift fails here instead of quietly re-governing a tool.
  it("every pi.registerTool call site is covered by the owned-tool name set", async () => {
    const files = await collectModules("src");
    let callSiteCount = 0;
    const literalNames: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      let at = source.indexOf("pi.registerTool(");
      while (at !== -1) {
        callSiteCount += 1;
        // Only the leading properties of this registration object. Tools that
        // spread a host factory carry their name from the spread, so no literal
        // is collected for them — the count check covers those.
        const head = source.slice(at, at + 240);
        const literal = head.match(/\bname:\s*"([^"]+)"/);
        if (literal) literalNames.push(literal[1]);
        at = source.indexOf("pi.registerTool(", at + 1);
      }
    }
    expect(callSiteCount).toBe(PI_OWNED_TOOL_NAMES.size);
    for (const name of literalNames) {
      expect(PI_OWNED_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});
