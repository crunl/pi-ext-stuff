/**
 * tree-sitter-bash WASM host bridge.
 *
 * Phase 0 of the Shell AST migration. This module owns every privileged action the
 * pure parser layer is forbidden to take: reading the grammar's `.wasm` off disk,
 * bringing up the web-tree-sitter runtime, and loading the language. The result is a
 * {@link ShellAstParser} that is *injected* into `src/permissions/shell-ast.ts`, so
 * the permission layer stays a pure function of text in, segments out.
 *
 * It lives outside `src/permissions/` on purpose: `tests/structure-invariants.test.ts`
 * forbids `node:fs` and `node:child_process` imports in the propose layer (except
 * `paths.ts`), and `tests/approve-for-me-engine.test.ts` closes the value graph
 * reachable from `src/approve-for-me-engine.ts`. Nothing here is imported by either.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  installShellAstParser,
  type ShellAstNode,
  type ShellAstParser,
  type ShellAstTree,
} from "../permissions/shell-ast.ts";

/**
 * Locate the grammar's `.wasm` through the package manager's own resolution
 * instead of assuming the layout Node happened to install here.
 * `tree-sitter-bash` ships no `exports` map and its `main` points at the
 * native binding (`bindings/node`), so the package entry does not lead to the
 * grammar — but a `package.json` specifier resolves to the package root, which
 * is where the package ships its `.wasm` (`files` includes `*.wasm`).
 *
 * Evaluated lazily and never throws: an unresolvable package must fail the
 * activation (and leave the lexer in charge), not the import of this module,
 * which `register.ts` imports statically.
 */
function resolveTreeSitterBashWasmPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve("tree-sitter-bash/package.json"));
    return join(packageRoot, "tree-sitter-bash.wasm");
  } catch {
    return undefined;
  }
}

/**
 * How much of the grammar an error is tolerated before the parser is abandoned.
 *
 * A truncated command has to stay *parseable enough* that the AST walker can still
 * find `rm -rf` inside it: an empty root means "nothing visible", which is the
 * fail-open that V2 exists to close. So a partial parse is kept when its root still
 * spans the command, and only a genuinely empty result is a hard failure.
 */
const MIN_ROOT_START_OFFSET = 0;

/**
 * `web-tree-sitter`'s ESM namespace. `default` is optional and self-referential because
 * the wrapper may expose `Parser`/`Language` either as named exports or on a default
 * object, depending on how the module was resolved.
 */
interface WebTreeSitterModule {
  default?: WebTreeSitterModule;
  Parser?: WasmParser;
  Language?: WasmLanguage;
}

/** Handle for the loaded grammar, opaque beyond "something `setLanguage` accepts". */
type WasmLanguageHandle = object;

interface WasmLanguage {
  load(bytes: Uint8Array): Promise<WasmLanguageHandle>;
}

interface WasmParser {
  init(): Promise<void>;
  new (): WasmParserInstance;
}

interface WasmParserInstance {
  setLanguage(language: WasmLanguageHandle): void;
  parse(input: string): WasmTree;
}

interface WasmTree {
  rootNode: WasmNode;
  delete(): void;
}

interface WasmNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  isMissing: boolean;
  childCount: number;
  hasError: boolean;
  isError: boolean;
  isNamed: boolean;
  children: WasmNode[];
  namedChildren: WasmNode[];
  namedChild(index: number): WasmNode | null;
  child(index: number): WasmNode | null;
}

/**
 * Loads `web-tree-sitter` through its `exports` map.
 *
 * `require.resolve` picks the `require` export condition, which
 * `web-tree-sitter@0.27.0` maps to the CommonJS build
 * (`./web-tree-sitter.cjs`); that namespace's `default` is the
 * module itself, so `namespace.default ?? namespace` reads
 * `Parser` / `Language` either way. `require()` of the resolved
 * URL is deliberate: the CJS wrapper's named exports are
 * populated synchronously, so they are readable right away, and
 * it works identically under Node, tsx and jiti without depending
 * on top-level await in an extension module.
 */
async function loadWebTreeSitter(): Promise<{ Parser: WasmParser; Language: WasmLanguage }> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("web-tree-sitter");
  const namespace = (await import(entry)) as WebTreeSitterModule;
  const module = namespace.default ?? namespace;
  if (!module.Parser || !module.Language) {
    throw new Error("web-tree-sitter did not export Parser and Language");
  }
  return { Parser: module.Parser, Language: module.Language };
}

/** Adapt the WASM node object to the frozen read-only shape the pure layer declares. */
function adaptNode(node: WasmNode): ShellAstNode {
  return {
    get type() {
      return node.type;
    },
    get text() {
      return node.text;
    },
    get startIndex() {
      return node.startIndex;
    },
    get endIndex() {
      return node.endIndex;
    },
    get isMissing() {
      return node.isMissing;
    },
    get childCount() {
      return node.childCount;
    },
    get hasError() {
      return node.hasError;
    },
    get isError() {
      return node.isError;
    },
    get isNamed() {
      return node.isNamed;
    },
    get children() {
      return node.children.map((child) => adaptNode(child));
    },
    get namedChildren() {
      return node.namedChildren.map((child) => adaptNode(child));
    },
    namedChild(index: number): ShellAstNode | null {
      const child = node.namedChild(index);
      return child ? adaptNode(child) : null;
    },
    child(index: number): ShellAstNode | null {
      const child = node.child(index);
      return child ? adaptNode(child) : null;
    },
  };
}

function adaptTree(tree: WasmTree): ShellAstTree {
  return {
    get rootNode() {
      return adaptNode(tree.rootNode);
    },
    delete() {
      tree.delete();
    },
  };
}

/** Why the bridge is unusable, reduced to what a caller can report without owning an `unknown`. */
export interface ShellBridgeFailure {
  name: string;
  message: string;
}

interface ShellBridgeState {
  /** The injected parser. Absent until {@link ensureTreeSitterReady} resolves. */
  parser?: ShellAstParser;
  /** Why initialization failed, when it did. */
  failure?: ShellBridgeFailure;
  /** True once a real parse attempt failed, so callers drop back to the lexer. */
  broken: boolean;
}

const state: ShellBridgeState = { broken: false };

/** The parser to inject into the pure layer, or `undefined` to stay on the lexer. */
export function shellAstParser(): ShellAstParser | undefined {
  return state.broken ? undefined : state.parser;
}

export function treeSitterShellFailure(): ShellBridgeFailure | undefined {
  return state.failure;
}

/**
 * Test seam: put the bridge back to its uninitialized state, including
 * the memoized activation, so a changed flag is read again.
 */
export function resetTreeSitterShellBackend(): void {
  delete state.parser;
  delete state.failure;
  state.broken = false;
  activation = undefined;
}

function describeFailure(reason: unknown): ShellBridgeFailure {
  if (reason instanceof Error) return { name: reason.name, message: reason.message };
  return { name: "UnknownError", message: String(reason) };
}

function markBroken(reason: unknown): void {
  state.failure = describeFailure(reason);
  state.broken = true;
  delete state.parser;
}

/**
 * The switch that turns the AST front end on.
 *
 * Read here, in the host, rather than in `src/permissions/`: the propose layer must stay
 * a pure function of its inputs, so it learns whether the migration is live only from
 * whether a parser was injected. `1` is the only value that enables it; anything else,
 * including an unset variable, leaves the shipped lexer in charge.
 */
export const TREE_SITTER_PARSER_ENV_FLAG = "PI_SAFETY_TREE_SITTER_PARSER";

export function treeSitterParserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TREE_SITTER_PARSER_ENV_FLAG] === "1";
}

/** The activation the host awaits, memoized so the barrier costs one promise forever. */
let activation: Promise<boolean> | undefined;

/**
 * Bring the grammar up and hand it to the pure layer, when the host asked for it.
 *
 * Three outcomes, and only the first changes how a command is read: flag off, so nothing
 * is loaded and nothing is injected; flag on and the grammar usable, so the parser is
 * installed; flag on and the grammar broken, so the lexer keeps running and
 * {@link treeSitterShellFailure} says why. Never throws, because a command still has to
 * be classified either way.
 */
export async function activateTreeSitterShellParser(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!treeSitterParserEnabled(env)) return false;
  activation ??= (async () => {
    await ensureTreeSitterReady();
    const parser = shellAstParser();
    if (parser === undefined) return false;
    installShellAstParser(parser);
    return true;
  })();
  return activation;
}

/** Test seam: forget the memoized activation, so a changed flag is read again. */
export function resetTreeSitterShellActivation(): void {
  activation = undefined;
}

/**
 * Bring the grammar up exactly once. Idempotent: every later call awaits the same
 * memo, so the barrier is free on the hot path.
 *
 * Never throws — a missing or corrupt `.wasm`, an ABI mismatch, or a blocked network
 * environment all leave the bridge unusable and the caller falls back to the lexer.
 */
export async function ensureTreeSitterReady(): Promise<void> {
  if (state.parser) return;
  if (state.broken) return;
  try {
    const wasmPath = resolveTreeSitterBashWasmPath();
    if (wasmPath === undefined) {
      markBroken(new Error("tree-sitter-bash package root could not be resolved"));
      return;
    }
    const { Parser, Language } = await loadWebTreeSitter();
    await Parser.init();
    const bytes = new Uint8Array(readFileSync(wasmPath));
    const language = await Language.load(bytes);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse("echo ok");
    let usable = false;
    try {
      const root = tree.rootNode;
      usable =
        root.type === "program" &&
        root.startIndex === MIN_ROOT_START_OFFSET &&
        root.endIndex > MIN_ROOT_START_OFFSET;
    } finally {
      tree.delete();
    }
    if (!usable) {
      markBroken(new Error("tree-sitter-bash produced an empty program node"));
      return;
    }
    state.parser = {
      parse(source: string): ShellAstTree {
        try {
          return adaptTree(parser.parse(source));
        } catch (error) {
          // A failure mid-parse means the instance can no longer be trusted.
          markBroken(error);
          throw error;
        }
      },
    };
  } catch (error) {
    markBroken(error);
  }
}
