import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

async function collectTs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTs(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("structure invariants named by the cohesion review", () => {
  it("legacy safe-command whitelist is removed from production", async () => {
    const files = await collectTs("src");
    expect(files.some((file) => file.endsWith("permissions/safe-commands.ts"))).toBe(false);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (text.includes("permissions/safe-commands")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
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
    const sandboxSource = await readFile("src/sandbox.ts", "utf8");
    const srtSource = await readFile("src/sandbox/srt-enforcer.ts", "utf8");
    for (const source of [sandboxSource, srtSource]) {
      expect(source).not.toContain("httpProxyPort");
      expect(source).not.toContain("socksProxyPort");
      expect(source).not.toContain("upstream_proxy");
    }
    expect(sandboxSource).not.toContain("feasible-allow");
    expect(srtSource).not.toContain("nono");
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

/** Transitive value-import closure over repo-local modules (type edges excluded). */
async function valueClosure(entry: string): Promise<Set<string>> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) break;
    for (const edge of await valueEdges(current)) {
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

async function valueNodeImports(repoFile: string): Promise<string[]> {
  return (await valueEdges(repoFile))
    .map((edge) => edge.target)
    .filter((target) => target.startsWith("node:"));
}

// Layer names below are enforced groupings, not directories: no decide/,
// propose/, review/, enforce/, or host/ directory exists in src/. Each rule
// keys on real modules (or the Engine value-closure), never on a path prefix,
// so the assertions survive renames.
const PROPOSE_MODULES = ["src/risk-policy.ts"];
const REVIEW_MODULES = [
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
];

async function proposeModules(): Promise<string[]> {
  const entries = await readdir("src/permissions");
  return [
    ...PROPOSE_MODULES,
    ...entries.filter((n) => n.endsWith(".ts")).map((n) => `src/permissions/${n}`),
  ];
}

describe("layer boundaries named by the import-graph review", () => {
  it("engine value-closure performs no I/O and binds no host packages", async () => {
    const closure = await valueClosure("src/approve-for-me-engine.ts");
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
          edge.target === "@anthropic-ai/sandbox-runtime"
        ) {
          offenders.push(`${file} -> ${edge.target}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only the engine declares the authority-minting names", async () => {
    const declarers = new Set<string>();
    for (const file of await collectTs("src")) {
      const text = await readFile(file, "utf8");
      if (
        /^\s*export\s+(type|interface)\s+(CapabilityLease|RetryHandle|AdmissionPlan)\b/m.test(text)
      ) {
        declarers.add(file.replace(/\\/g, "/"));
      }
    }
    expect([...declarers].sort()).toEqual(["src/approve-for-me-engine.ts"]);
  });

  it("propose layer never touches authority names and owns no I/O but paths.ts", async () => {
    const authorityOffenders: string[] = [];
    const ioOffenders: string[] = [];
    for (const file of await proposeModules()) {
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
      }
    }
    expect(authorityOffenders).toEqual([]);
    expect(ioOffenders).toEqual([]);
  });

  it("review layer never wires the host and spawns only via the worker client", async () => {
    const hostOffenders: string[] = [];
    const spawnOffenders: string[] = [];
    for (const file of REVIEW_MODULES) {
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
    for (const file of await collectTs("src")) {
      for (const edge of await valueEdges(file)) {
        if (edge.target === "@anthropic-ai/sandbox-runtime")
          importers.add(file.replace(/\\/g, "/"));
      }
    }
    for (const file of ["src/guardian-worker.mjs", "src/guardian-worker-limits.mjs"]) {
      const text = await readFile(file, "utf8");
      if (/^\s*import\s+.*\bfrom\s+"@anthropic-ai\/sandbox-runtime"/m.test(text))
        importers.add(file);
    }
    expect([...importers].sort()).toEqual([
      "src/guardian-worker.mjs",
      "src/sandbox/srt-enforcer.ts",
    ]);
    // The authorizer reaches enforcement only through the pure projection seam.
    const closure = await valueClosure("src/approve-for-me-engine.ts");
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
    const piCore = new Set<string>();
    for (const file of await collectTs("src")) {
      const name = file.replace(/\\/g, "/");
      for (const edge of await valueEdges(file)) {
        if (edge.target === "@earendil-works/pi-coding-agent") codingAgent.add(name);
        if (
          edge.target === "@earendil-works/pi-ai" ||
          edge.target === "@earendil-works/pi-ai/compat"
        ) {
          piAi.add(name);
        }
        if (edge.target === "../../pi-core/standalone.ts") piCore.add(name);
      }
    }
    // Scope is per package: pi-ai/compat has its own single sanctioned importer.
    expect([...codingAgent].sort()).toEqual(["src/guardian-tools.ts", "src/register.ts"]);
    expect([...piAi].sort()).toEqual(["src/auto-reviewer.ts"]);
    expect([...piCore].sort()).toEqual(["src/register.ts"]);
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
});
