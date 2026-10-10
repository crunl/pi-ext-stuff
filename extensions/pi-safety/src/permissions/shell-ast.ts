/**
 * tree-sitter-bash AST front end: the sole shell interpreter.
 *
 * This module turns a parsed `bash` syntax tree into the per-segment input
 * the fold in `shell-segment.ts` consumes: a source span, the argv words the
 * shell would build, and the facts that decide whether the segment can be
 * trusted. The fold makes every verdict.
 *
 * It holds no privileged I/O. The tree arrives through the injected
 * {@link ShellAstParser} because `tests/structure-invariants.test.ts` forbids
 * `node:fs` inside `src/permissions/`, while the grammar has to be read off disk by
 * the host bridge in `src/tree-sitter/`. `import type` never appears here at all:
 * `web-tree-sitter` is a bare specifier the engine's value graph must not gain.
 *
 * Two rules govern every branch below.
 *
 *  - **The grammar is the answer.** Word lists are built from the grammar's
 *    own nodes (quote/escape processing per word, never re-splitting), and
 *    liveness from the grammar's expansion nodes. There is no text scan to
 *    union with: what the tree does not say is not claimed.
 *  - **Unmodelled syntax is not a judgement.** Anything this adapter cannot
 *    express as segments returns `undefined` and the caller fails the command
 *    closed to review. An ERROR node is different: it is modelled, and its
 *    span reviews as incomplete text.
 */
import { outermostSubstitutionBodies } from "./shell-tokens.ts";

/**
 * The frozen read-only view of a tree-sitter node that this adapter needs.
 *
 * Declared here rather than imported from `web-tree-sitter`, so the permission layer
 * keeps no type edge to the WASM package and the bridge owns the translation.
 */
export interface ShellAstNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  childCount: number;
  hasError: boolean;
  isError: boolean;
  isMissing: boolean;
  isNamed: boolean;
  children: ShellAstNode[];
  namedChildren: ShellAstNode[];
  namedChild(index: number): ShellAstNode | null;
  child(index: number): ShellAstNode | null;
}

export interface ShellAstTree {
  readonly rootNode: ShellAstNode;
  delete(): void;
}

export interface ShellAstParser {
  parse(source: string): ShellAstTree;
}

/**
 * What the interpreter must tell the fold about one segment: the source span,
 * the argv the shell would build (quotes stripped, redirects removed), and
 * the facts that decide whether the segment can be trusted.
 *
 * `lexIncomplete` is the fold's only "is this the whole word list" question:
 * the adapter sets it for a tree that carried an error node inside the
 * statement's own span.
 */
export interface SegmentFacts {
  /** The raw command text this segment covers, delimiters trimmed. */
  source: string;
  /** The argv the shell would build: quotes stripped, redirects removed. */
  words: string[];
  /**
   * The text that ran is not the text that was read: an error region the
   * grammar marked inside the statement's tree, or a span recovered from an
   * ERROR node. The fold only ever asks "is this the whole word list".
   */
  lexIncomplete: boolean;
  hasExecutableSubstitution: boolean;
  hasActiveRedirect: boolean;
  hasHereDocument: boolean;
  /**
   * Whether one of this segment's pending heredocs was active (a bare,
   * unquoted delimiter) AND its body carried expansion characters
   * (`/[$`]/`). The fold gates the `heredoc_unproven` clause on this,
   * not on the blanket `hasHereDocument` provenance marker: an inert
   * (quoted/escaped-delimiter) body, or a bare body with no `$`/backtick,
   * never makes the static argv a lie about the runtime argv.
   */
  heredocExpansionRisk: boolean;
  /** Live `$(…)`, backtick and `<(…)` bodies, in source order — the nested argv. */
  bodies: string[];
}

export interface AstAnalysis {
  segments: SegmentFacts[];
  /** True when the tree carried an ERROR or MISSING node anywhere. */
  hadError: boolean;
}

/** Statement node types that become segments. Anything else abstains (fail-closed). */
const STATEMENT_NODES = new Set([
  "command",
  "variable_assignment",
  "redirected_statement",
  "declaration_command",
  "test_command",
]);

/**
 * Composition nodes whose command children run: descending is equivalent to
 * sequencing, so every inner command becomes its own segment (codex-style AST
 * descent). Non-command leaves (loop variables, test expressions, case words)
 * are skipped, never abstained on: they name no program.
 */
const COMPOSITION_NODES = new Set([
  "program",
  "list",
  "pipeline",
  "compound_statement",
  "subshell",
  "command_group",
  "negated_command",
  "for_statement",
  "while_statement",
  "until_statement",
  "if_statement",
  "elif_clause",
  "else_clause",
  "then_clause",
  "do_group",
  "case_statement",
  "case_item",
  "function_definition",
]);

/** Node types that run as commands no matter where they sit. */
const EXECUTABLE_STRUCTURE_NODES = new Set([
  "command",
  "pipeline",
  "list",
  "compound_statement",
  "subshell",
  "command_group",
  "negated_command",
  "for_statement",
  "while_statement",
  "until_statement",
  "if_statement",
  "function_definition",
]);

function redirectHidesExecutable(redirect: ShellAstNode): boolean {
  for (const child of redirect.children) {
    // Substitutions surface through the bodies path (`collectSubstitutions`
    // walks non-heredoc redirects), so their insides are owned there — only
    // structure that runs AS a command counts here.
    if (
      child.type === "command_substitution" ||
      child.type === "process_substitution" ||
      EXPANSION_NODES.has(child.type)
    ) {
      continue;
    }
    if (EXECUTABLE_STRUCTURE_NODES.has(child.type) || redirectHidesExecutable(child)) {
      return true;
    }
  }
  return false;
}

/** Node types that carry argv. A named command child of any other type is outside the model. */
const ARGV_NODES = new Set([
  "command_name",
  "variable_assignment",
  "variable_name",
  "word",
  "number",
  "string",
  "raw_string",
  "ansi_c_string",
  "string_content",
  "concatenation",
  "simple_expansion",
  "expansion",
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
  "comment",
  "test_operator",
  "unary_expression",
  "binary_expression",
  "parenthesized_expression",
]);

const REDIRECT_NODES = new Set(["file_redirect", "heredoc_redirect", "herestring_redirect"]);

/** Redirect operators that duplicate a descriptor: what follows is a descriptor, not a file. */
const DESCRIPTOR_REDIRECTS = new Set([">&", "<&"]);

/** Expansions that rewrite a word before the command runs. */
const EXPANSION_NODES = new Set([
  "simple_expansion",
  "expansion",
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
]);

/**
 * How many live substitution bodies one statement reports. One past
 * `MAX_SUBSTITUTION_NESTING` in `shell-segment.ts`, so the fold's depth
 * bound is never the reason a body goes unreported. The cap bounds work
 * only: the `substitution` flag comes from the scan, not from the count,
 * and the fold's `substitution_unproven` verdict reads
 * `hasExecutableSubstitution`, so reaching the cap changes nothing a
 * consumer can see - it only stops the list growing.
 */
const MAX_SUBSTITUTION_BODIES = 9;

/**
 * The parser the host installed, or `undefined` to stay on the lexer.
 *
 * Holding it here, rather than reading an environment variable, is what keeps the
 * propose layer pure: `src/tree-sitter/shell-backend.ts` decides whether the
 * migration is enabled and whether the grammar is ready, and this module only sees a
 * parser or does not. One process-wide slot is enough because the whole extension
 * runs in one process and the parser is a read-only grammar handle.
 */
let installedParser: ShellAstParser | undefined;

export function installShellAstParser(parser: ShellAstParser | undefined): void {
  installedParser = parser;
}

export function shellAstParserInstalled(): boolean {
  return installedParser !== undefined;
}

/**
 * Analyze `source` with the installed parser, or `undefined` when there is none.
 *
 * The single entry the segment fold calls: it owns the "no parser installed" answer so
 * no caller has to know whether the migration is on.
 */
export function analyzeCommandWithAst(source: string): AstAnalysis | undefined {
  if (installedParser === undefined) return undefined;
  return analyzeShellAst(source, installedParser);
}

/** Above this the fold refuses the argv as untrustworthy. */
const MAX_SEGMENT_WORDS = 1024;

/** A statement, flattened, with the span of text its segment is named for. */
interface StatementInfo {
  /** The node whose children are the argv, when the statement has one. */
  command?: ShellAstNode;
  redirects: ShellAstNode[];
  /** A comment sharing this statement's line, kept because the lexer keeps it. */
  comment?: ShellAstNode;
  start: number;
  end: number;
}

interface OrderedSegment {
  order: number;
  segment: SegmentFacts;
}

interface AnalysisOutput {
  statements: StatementInfo[];
  /** Recovered error spans, materialized as lexer-shaped segments. */
  errors: ShellAstNode[];
  /** Comments on a line of their own, which are segments of nothing but themselves. */
  comments: ShellAstNode[];
}

/**
 * Parse `source` into segments, or `undefined` when the command is outside what this
 * adapter models (including a parse that threw). The tree is always released.
 */
export function analyzeShellAst(source: string, parser: ShellAstParser): AstAnalysis | undefined {
  let tree: ShellAstTree;
  try {
    tree = parser.parse(source);
  } catch {
    return undefined;
  }
  try {
    const root = tree.rootNode;
    const out: AnalysisOutput = { statements: [], errors: [], comments: [] };
    if (!collectStatements(source, root, out)) return undefined;
    const hadError = root.hasError || root.childCount === 0;
    // A heredoc redirect the grammar could not read whole (ERROR inside it)
    // means the body queue is untrustworthy: error recovery invents commands
    // from body data, and no span past the opener can be proven code. The
    // command abstains and reviews. ERROR elsewhere does NOT abstain: a
    // known command with an error region (`git add "${…;}"`, whose bad
    // substitution bash itself rejects) still collects, and its statement
    // reads incomplete via `statementHasError` — nothing runs, so it Skips
    // instead of reviewing a command the shell refuses.
    if (
      out.statements.some((statement) =>
        statement.redirects.some(
          (redirect) => redirect.type === "heredoc_redirect" && subtreeIsError(redirect),
        ),
      )
    ) {
      return undefined;
    }
    // An ERROR span holding a heredoc opener without its end is an unclosed
    // heredoc (`cat <<2X` whose `2X` line never comes): the body runs to end
    // of source, so the span shreds no commands and nothing collected past
    // the opener line is code. Without this the body data after a digit-led
    // (or otherwise missed) delimiter becomes segments and a deletion the
    // shell never runs reviews.
    suppressUnclosedHeredocErrors(source, out);
    dropHeredocBodyStatements(source, out);
    const ordered: OrderedSegment[] = [];
    for (const statement of out.statements) {
      const segment = buildSegment(source, statement);
      if (segment) ordered.push({ order: statement.start, segment });
    }
    // A comment on a line of its own is a segment of nothing but itself;
    // a trailing comment already joined its statement's span above.
    for (const comment of out.comments) {
      const text = comment.text.trim();
      if (text) ordered.push({ order: comment.startIndex, segment: commentFacts(text) });
    }
    if (hadError) addErrorSegments(out.errors, out.statements, ordered);
    if (hadError && !ordered.length && source.trim()) {
      ordered.push({ order: 0, segment: errorFacts(source.trim()) });
    }
    ordered.sort((left, right) => left.order - right.order);
    return { segments: ordered.map((entry) => entry.segment), hadError };
  } finally {
    tree.delete();
  }
}

/**
 * Walk the structural nodes and collect statements.
 *
 * Composition nodes (`;`, `&&`, `||`, `|`, braces, subshells, control flow)
 * descend: every inner command becomes its own segment. Non-command leaves
 * (loop variables, test operands, case words) are skipped, never abstained
 * on. A redirect whose statement is anything but a modelled command form is
 * refused by `redirectedStatement`.
 */
function collectStatements(source: string, node: ShellAstNode, out: AnalysisOutput): boolean {
  const { statements, errors, comments } = out;
  if (node.isError || node.isMissing) {
    errors.push(node);
    return true;
  }
  if (COMPOSITION_NODES.has(node.type)) {
    for (const child of node.children) {
      if (!child.isNamed) continue;
      if (child.type === "comment") {
        // A trailing comment joins the previous statement's span; a leading
        // one is a segment of nothing but itself.
        const previous = statements[statements.length - 1];
        if (previous && sameLine(source, previous.end, child.startIndex)) {
          previous.comment = child;
          previous.end = child.endIndex;
          continue;
        }
        comments.push(child);
        continue;
      }
      if (STATEMENT_NODES.has(child.type) || COMPOSITION_NODES.has(child.type)) {
        if (!collectStatements(source, child, out)) return false;
        continue;
      }
      if (child.isError || child.isMissing) {
        errors.push(child);
      }
      // Otherwise a loop variable, test operand, case word or function name:
      // no program, skipped by falling off the loop end.
    }
    return true;
  }
  if (!STATEMENT_NODES.has(node.type)) return false;
  if (node.type === "redirected_statement") {
    // `A && B >out` parses as one redirected statement around a list: the
    // redirect feeds the last command, so the inner composition becomes its
    // own segments and the redirect lands on the final one. (`A && B <<EOF`
    // is shape 31's form.)
    const inner = node.namedChildren.filter((child) => !REDIRECT_NODES.has(child.type));
    if (inner.some((child) => COMPOSITION_NODES.has(child.type))) {
      for (const child of inner) {
        if (STATEMENT_NODES.has(child.type) || COMPOSITION_NODES.has(child.type)) {
          if (!collectStatements(source, child, out)) return false;
          continue;
        }
        if (child.isError || child.isMissing) {
          errors.push(child);
          continue;
        }
        return false;
      }
      const last = statements[statements.length - 1];
      if (!last) return false;
      const attached = node.namedChildren.filter((child) => REDIRECT_NODES.has(child.type));
      // A redirect the grammar nested a pipeline inside (`<<'EOF' | $(…)`)
      // runs code the argv walk never visits: abstain, don't drop it.
      if (attached.some(redirectHidesExecutable)) return false;
      last.redirects.push(...attached);
      last.end = node.endIndex;
      return true;
    }
    const statement = redirectedStatement(node);
    if (!statement) return false;
    statements.push(statement);
    return true;
  }
  if (!hasModelledArgv(node)) return false;
  const redirects = redirectChildren(node);
  // Same executable-structure rule as `redirectedStatement`: a redirect
  // hiding a pipeline runs code the argv walk never visits.
  if (redirects.some(redirectHidesExecutable)) return false;
  statements.push({
    command: node,
    redirects,
    start: node.startIndex,
    end: node.endIndex,
  });
  return true;
}

function sameLine(source: string, from: number, to: number): boolean {
  return !source.slice(from, to).includes("\n");
}

function subtreeHas(node: ShellAstNode, type: string): boolean {
  if (node.type === type) return true;
  return node.children.some((child) => subtreeHas(child, type));
}

/** Whether the subtree holds an ERROR node (MISSING nodes don't count). */
function subtreeIsError(node: ShellAstNode): boolean {
  if (node.isError) return true;
  return node.children.some((child) => subtreeIsError(child));
}

function heredocStartEnd(node: ShellAstNode): number | undefined {
  if (node.type === "heredoc_start") return node.endIndex;
  for (const child of node.children) {
    const found = heredocStartEnd(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * An ERROR span is an unclosed heredoc when its subtree holds an opener
 * without an end: the grammar saw `<<DELIM` but no delimiter line. The body
 * then runs to end of source — every word past the opener line is data.
 */
function errorIsUnclosedHeredoc(node: ShellAstNode): boolean {
  return subtreeHas(node, "heredoc_start") && !subtreeHas(node, "heredoc_end");
}

function suppressUnclosedHeredocErrors(source: string, out: AnalysisOutput): void {
  const unclosed = out.errors.filter(errorIsUnclosedHeredoc);
  if (unclosed.length === 0) return;
  const cuts = unclosed.map((node) => {
    const openerEnd = heredocStartEnd(node) ?? node.startIndex;
    const newline = source.indexOf("\n", openerEnd);
    return newline === -1 ? source.length : newline + 1;
  });
  const cutFrom = Math.min(...cuts);
  out.statements = out.statements.filter((statement) => statement.start < cutFrom);
  out.comments = out.comments.filter((comment) => comment.startIndex < cutFrom);
  out.errors = out.errors.filter((node) => !unclosed.includes(node));
}

/**
 * Drop statements the grammar recovered from heredoc body data, in place.
 *
 * A body span (`heredoc_body` through its delimiter line) owns its lines:
 * any *other* statement starting inside one is data, not code. And a
 * delimiter line that is not the bare delimiter never closes in real bash —
 * the body runs to end of source — so every statement after the opener is
 * data, and the opener is marked by extending its end to end-of-source.
 */
function dropHeredocBodyStatements(source: string, out: AnalysisOutput): void {
  interface BodySpan {
    start: number;
    end: number;
    owner: StatementInfo;
    unclosed: boolean;
  }
  const spans: BodySpan[] = [];
  for (const statement of out.statements) {
    for (const redirect of statement.redirects) {
      if (redirect.type !== "heredoc_redirect") continue;
      const body = redirect.namedChildren.find((child) => child.type === "heredoc_body");
      const end = redirect.namedChildren.find((child) => child.type === "heredoc_end");
      if (!end) {
        // No delimiter at all: unclosed, body runs to end of source.
        const openLine = source.indexOf("\n", redirect.startIndex);
        spans.push({
          start: openLine === -1 ? source.length : openLine + 1,
          end: source.length,
          owner: statement,
          unclosed: true,
        });
        continue;
      }
      const lineStart = source.lastIndexOf("\n", end.startIndex - 1) + 1;
      let lineEnd = source.indexOf("\n", end.endIndex);
      lineEnd = lineEnd === -1 ? source.length : lineEnd;
      const bare = source.slice(lineStart, lineEnd).trim() === end.text.trim();
      if (!bare) {
        // Never closes: everything after the opener line is data.
        const openLine = source.indexOf("\n", redirect.startIndex);
        spans.push({
          start: openLine === -1 ? source.length : openLine + 1,
          end: source.length,
          owner: statement,
          unclosed: true,
        });
        continue;
      }
      const bodyStart = body?.startIndex ?? lineEnd;
      spans.push({ start: bodyStart, end: lineEnd, owner: statement, unclosed: false });
    }
  }
  if (spans.length === 0) return;
  out.statements = out.statements.filter((statement) => {
    for (const span of spans) {
      if (span.owner === statement) continue;
      if (statement.start >= span.start && statement.start < span.end) return false;
      if (span.unclosed && statement.start >= span.start) return false;
    }
    return true;
  });
  out.comments = out.comments.filter((comment) => {
    for (const span of spans) {
      if (comment.startIndex >= span.start && comment.startIndex < span.end) return false;
      if (span.unclosed && comment.startIndex >= span.start) return false;
    }
    return true;
  });
  // An unclosed body makes the opener's own text unread whole: it runs to end
  // of source, so extend the span to cover the data it swallowed.
  for (const span of spans) {
    if (span.unclosed) span.owner.end = source.length;
  }
}

/** Whether every named child of a command is argv, a redirect, or an error region. */
function hasModelledArgv(node: ShellAstNode): boolean {
  for (const child of node.children) {
    if (!child.isNamed) continue;
    if (child.isError || child.isMissing) continue;
    if (REDIRECT_NODES.has(child.type)) continue;
    if (!ARGV_NODES.has(child.type)) return false;
  }
  return true;
}

function redirectChildren(node: ShellAstNode): ShellAstNode[] {
  return node.children.filter((child) => REDIRECT_NODES.has(child.type));
}

/**
 * A `redirected_statement` is a command with redirects attached as siblings, so the
 * redirects do not name the executable. A bare redirect (`>out`) has no command:
 * it truncates/creates a file, which the sandbox owns — modelled as a nameless
 * statement, exactly like the fold's nameless branch.
 */
function redirectedStatement(node: ShellAstNode): StatementInfo | undefined {
  let command: ShellAstNode | undefined;
  const redirects: ShellAstNode[] = [];
  for (const child of node.namedChildren) {
    if (REDIRECT_NODES.has(child.type)) {
      // A redirect the grammar nested a pipeline inside (`<<'EOF' | $(…)`)
      // runs code the argv walk never visits: abstain, don't drop it.
      if (redirectHidesExecutable(child)) return undefined;
      redirects.push(child);
      continue;
    }
    if (
      child.type === "command" ||
      child.type === "variable_assignment" ||
      child.type === "declaration_command" ||
      child.type === "test_command"
    ) {
      if (command || !hasModelledArgv(child)) return undefined;
      command = child;
      continue;
    }
    return undefined;
  }
  return { command, redirects, start: node.startIndex, end: node.endIndex };
}

/**
 * Segments for the recovered ERROR spans.
 *
 * The reason an error is not simply "give up" is `rm -rf $(`: tree-sitter recovers by
 * marking part of the tree as ERROR, and that region still names the dangerous argv.
 * Lexing it keeps tier 1's view that a forced deletion was present, and the segment is
 * incomplete by construction, which fails the fold closed. A span already covered by a
 * collected statement is skipped: the statement read the same text.
 */
function addErrorSegments(
  errors: readonly ShellAstNode[],
  statements: readonly StatementInfo[],
  ordered: OrderedSegment[],
): void {
  for (const node of errors) {
    const text = node.text.trim();
    if (!text) continue;
    if (
      statements.some(
        (statement) => node.startIndex < statement.end && node.endIndex > statement.start,
      )
    )
      continue;
    for (const piece of errorPieces(text)) {
      ordered.push({
        order: node.startIndex,
        // An error region is text the grammar could not read, so
        // the segment is incomplete by construction: `$(` names an
        // unclosed substitution no word scan models as complete.
        segment: { ...errorFacts(piece), lexIncomplete: true },
      });
    }
  }
}

/**
 * Cut an error span into pieces on composition operators, quote-aware.
 * Error text is unreadable by definition, so this is deliberately crude next
 * to the grammar: splitting can only add segments (more inspection, never
 * less), while one span for the whole text would mash separate commands'
 * words into one argv and could hide a dangerous executable.
 */
function errorPieces(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      current += character;
      quote = character;
      continue;
    }
    if (
      character === ";" ||
      character === "&" ||
      character === "|" ||
      character === "\n" ||
      character === "(" ||
      character === ")"
    ) {
      if (current.trim()) pieces.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

/**
 * Facts for text the grammar could not read: a recovered error span or a
 * whole command behind a failed parse. Words are whitespace-separated and
 * quote-stripped best-effort — enough that `"rm` still names `rm` for the
 * danger check — and liveness is a character test: an unread span cannot
 * prove its `$` inert.
 */
function errorFacts(source: string): SegmentFacts {
  const words = source
    .split(/\s+/)
    .filter((word) => word !== "")
    .flatMap(dequoteWord);
  return {
    source,
    words,
    lexIncomplete: true,
    hasExecutableSubstitution: /[$`]/.test(source),
    hasActiveRedirect: /[<>]/.test(source),
    hasHereDocument: source.includes("<<"),
    heredocExpansionRisk: false,
    bodies: outermostSubstitutionBodies(source),
  };
}

/**
 * Facts for a comment on a line of its own. A comment never runs, so its
 * words name no program: the executable slot reads `#`, and liveness is
 * never attributed (a `$(…)` inside a comment is text, not source).
 */
function commentFacts(source: string): SegmentFacts {
  const words = source.split(/\s+/).filter((word) => word !== "");
  return {
    source,
    words,
    lexIncomplete: false,
    hasExecutableSubstitution: false,
    hasActiveRedirect: false,
    hasHereDocument: false,
    heredocExpansionRisk: false,
    bodies: [],
  };
}

/**
 * The segment for one statement: text, argv, and facts.
 *
 * Words come from the grammar's own nodes: each argv child dequotes to whole
 * words (a substitution spelling is one argv word, exactly as the shell
 * passes it), and a line continuation joining two children joins their words.
 * A `|` inside quotes never shreds a segment, and `cd '${D}'` keeps its
 * target literal — because the tree, not a character scan, cut the words.
 */
function buildSegment(source: string, statement: StatementInfo): SegmentFacts | undefined {
  const text = source.slice(statement.start, statement.end).trim();
  if (!text) return undefined;
  const words = statement.command ? commandWords(source, statement.command) : [];
  for (const redirect of statement.redirects) words.push(...redirectWords(redirect));
  if (statement.comment) words.push(...commentTailWords(statement.comment.text));
  if (words.length > MAX_SEGMENT_WORDS) return undefined;
  const substitutions = collectSubstitutions(statement);
  // Active heredoc bodies run their substitutions (the shell re-reads the
  // body), so their live bodies join the expansion set directly from the
  // grammar, at any nesting depth or queue position. Inert
  // (quoted/escaped-delimiter) bodies are literal text.
  const heredoc = collectHeredocBodies(statement);
  const bodies = [...new Set([...substitutions.bodies, ...heredoc.bodies])];
  return {
    source: text,
    words,
    // An error region the grammar marked inside the statement's own tree
    // means the text that ran is not the text that was read.
    lexIncomplete: statementHasError(statement),
    hasExecutableSubstitution:
      substitutions.substitution || heredoc.substitution || liveAssignments(statement.command),
    hasActiveRedirect: statement.redirects.length > 0,
    hasHereDocument: hereDocuments(statement.redirects),
    heredocExpansionRisk: heredoc.expansionRisk,
    bodies,
  };
}

/**
 * The argv words of one command node.
 *
 * Each argv child yields whole words via {@link dequoteWord}: the grammar
 * already split words, so re-splitting would shred one argv word (a `<(…)`
 * spelling, a quoted space) into several. Anonymous leading text names the
 * executable the named walk would skip: the declaration builtin (`export`),
 * the test brackets (`[[`), and nothing for a bare assignment (which starts
 * with its named variable). A backslash-newline between two children joins
 * them (`r\\` + newline + `m` runs `rm`): the gap is read off source offsets,
 * so a backslash that is truly the last character still fails visibly.
 */
function commandWords(source: string, command: ShellAstNode): string[] {
  const words: string[] = [];
  const named = command.children.filter(
    (child) => child.isNamed && !child.isError && !child.isMissing,
  );
  const leading = named.length > 0 ? source.slice(command.startIndex, named[0]?.startIndex ?? 0) : "";
  const builtin = leading.trim();
  if (builtin !== "") words.push(builtin);
  let previous: ShellAstNode | undefined;
  for (const child of named) {
    if (REDIRECT_NODES.has(child.type) || child.type === "comment") {
      previous = child;
      continue;
    }
    const prior = previous;
    previous = child;
    const current = dequoteWord(child.text);
    if (
      prior &&
      words.length > 0 &&
      isLineContinuation(source.slice(prior.endIndex, child.startIndex))
    ) {
      words[words.length - 1] = (words[words.length - 1] ?? "") + (current.shift() ?? "");
    }
    words.push(...current);
  }
  return words;
}

/** Whether the source gap between two children is a line continuation. */
function isLineContinuation(gap: string): boolean {
  return /^\\\r?\n$/.test(gap);
}

/**
 * One grammar word with the quotes the shell would remove. Returns whole
 * words only — never splits: the caller walks one node per word already, and
 * splitting here would shred a single argv word (`<(echo hi)`, `"a b"`) the
 * way the retired character splitter did. Unbalanced quotes strip
 * best-effort rather than failing: error text still has to name `rm`.
 */
function dequoteWord(text: string): string[] {
  let out = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (escaped) {
      // A backslash-newline is a continuation: removed before word
      // splitting, so it joins rather than escapes.
      if (character !== "\n" && character !== "\r") out += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else out += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    out += character;
  }
  // A trailing lone backslash escapes nothing; the character is kept rather
  // than dropped, so no word silently vanishes.
  if (escaped) out += "\\";
  return [out];
}

/** A trailing comment's words: split only, never dequoted or scanned. */
function commentTailWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "");
}

/**
 * The live substitution bodies inside a statement's own active heredoc
 * bodies, plus whether any active body carries expansion characters.
 *
 * Mirrors the shell's active/inert rule on the grammar's nodes: a quoted
 * or escaped delimiter (`<<'X'`, `<<"X"`, `<<\X`) makes the body literal;
 * a bare delimiter re-reads it. `heredoc_start` text carries the quotes, so
 * the first character decides.
 */
function collectHeredocBodies(statement: StatementInfo): {
  substitution: boolean;
  expansionRisk: boolean;
  bodies: string[];
} {
  let substitution = false;
  let expansionRisk = false;
  const bodies: string[] = [];
  for (const redirect of statement.redirects) {
    if (redirect.type !== "heredoc_redirect") continue;
    const start = redirect.namedChildren.find((child) => child.type === "heredoc_start");
    const body = redirect.namedChildren.find((child) => child.type === "heredoc_body");
    if (!body) continue;
    const delimiter = start?.text ?? "";
    if (delimiter.startsWith("'") || delimiter.startsWith('"') || delimiter.startsWith("\\")) {
      continue;
    }
    if (/[$`]/.test(body.text)) {
      substitution = true;
      expansionRisk = true;
      // Outermost sites only (see `outermostSubstitutionBodies`): deeper
      // levels surface through the expander's recursion.
      for (const live of outermostSubstitutionBodies(body.text)) {
        if (bodies.length >= MAX_SUBSTITUTION_BODIES) break;
        bodies.push(live);
      }
    }
  }
  return { substitution, expansionRisk, bodies };
}

/**
 * Whether any node inside the statement's own tree carried an error.
 *
 * This is the whole fail-closed rule for unread text: an ERROR node inside
 * the statement's subtree — a `$(` whose substitution never closed, say —
 * means the grammar did not read this statement's text cleanly, which the
 * word scan alone would not report. A dangling operator produces the
 * opposite shape: `&&`, `||` or `|` at the end of a line (`;` or `|` at
 * its start) recovers as an empty-span ERROR node that is a sibling of the
 * command and lies inside no statement's subtree, so no statement reports
 * an error and the fold reads the clean argv as-is.
 */
function statementHasError(statement: StatementInfo): boolean {
  return (
    statement.command?.hasError === true ||
    statement.redirects.some((redirect) => redirect.hasError) ||
    statement.comment?.hasError === true
  );
}

/**
 * The argv a redirect contributes.
 *
 * The operator and its target are shell syntax, not arguments, so nothing is emitted
 * for them. `git > push origin` is the case that needs more than that: the grammar
 * swallows `push origin` into the redirect, while the shell writes to `push` and passes
 * `origin` as an argument. So the first target is dropped and any word behind it is
 * kept. A descriptor duplication (`2>&1`) keeps nothing, because what follows is a
 * descriptor rather than a file or an argument.
 */
function redirectWords(redirect: ShellAstNode): string[] {
  // Heredoc bodies are the command's input data, never argv: `cat <<EOF\nrm
  // -rf /\nEOF` runs `cat`, and the body must not leak into the word list.
  if (redirect.type === "heredoc_redirect" || redirect.type === "herestring_redirect")
    return [];
  const operator = redirectOperator(redirect);
  if (operator && DESCRIPTOR_REDIRECTS.has(operator)) return [];
  const targets = redirect.namedChildren.filter(
    (child) => child.type !== "file_descriptor" && !child.isError && !child.isMissing,
  );
  // The first target is the file the shell writes; any word behind it is an
  // argument the redirect swallowed. Each target dequotes whole: targets are
  // single words by construction.
  return targets.slice(1).flatMap((child) => dequoteWord(child.text));
}

function redirectOperator(redirect: ShellAstNode): string | undefined {
  return redirect.children.find((child) => !child.isNamed && /^[<>&|]+/.test(child.text))?.text;
}

function hereDocuments(redirects: readonly ShellAstNode[]): boolean {
  return redirects.some((redirect) => redirect.type === "heredoc_redirect");
}

/**
 * Whether a statement's assignments expand: `FOO=$(whoami) bar` and
 * `FOO="a b" bar` both hand the later words a value the static argv never
 * named, while `FOO='$(pwd)' bar` never expands. Read off the value node's
 * own subtree — a substitution node, or a `$`/backtick the grammar left as
 * word text — rather than re-scanning characters.
 */
function liveAssignments(command: ShellAstNode | undefined): boolean {
  if (!command) return false;
  return command.children.some((child) => {
    if (child.type !== "variable_assignment") return false;
    const value = child.children.find((inner) => inner.isNamed && inner.type !== "variable_name");
    return value !== undefined && scanExpansions(value).literal;
  });
}

interface SubstitutionScan {
  substitution: boolean;
  bodies: string[];
}

/**
 * The live expansions of a statement, in source order.
 *
 * Inert by the shell's own rules — a single-quoted region — is skipped, and
 * an assignment value is included, because `FOO=$(whoami) bar` does run that
 * substitution. A body is reported once for the statement; deeper levels
 * surface through the expander's recursion.
 */
function collectSubstitutions(statement: StatementInfo): SubstitutionScan {
  const nodes: ShellAstNode[] = [];
  if (statement.command) nodes.push(statement.command);
  // An inert heredoc body (quoted/escaped delimiter) is literal text the shell
  // never re-reads: scanning it reports a `$` the shell never expands — the
  // false-positive review shape 31 pins (`<<'EOF'` + `$(rm…)` must stay Skip).
  // Active bodies are owned by `collectHeredocBodies`, not by this walk.
  for (const redirect of statement.redirects) {
    if (redirect.type === "heredoc_redirect") continue;
    nodes.push(redirect);
  }
  if (statement.comment) nodes.push(statement.comment);
  let substitution = false;
  const bodies: string[] = [];
  for (const node of nodes) {
    const found = scanExpansions(node);
    if (found.expansions.length) {
      substitution = true;
      for (const body of found.expansions) {
        if (bodies.length >= MAX_SUBSTITUTION_BODIES) break;
        bodies.push(body);
      }
    }
    if (found.literal) substitution = true;
  }
  return { substitution, bodies };
}

interface ExpansionScan {
  /** True when a `$` or backtick sits outside an inert region. */
  literal: boolean;
  /** The inner text of every live command or process substitution. */
  expansions: string[];
}

function scanExpansions(node: ShellAstNode): ExpansionScan {
  if (node.isError || node.isMissing) return { literal: false, expansions: [] };
  if (node.type === "raw_string") return { literal: false, expansions: [] };
  if (node.type === "heredoc_body" || node.type === "heredoc_end") {
    // Reached only through a redirect child the caller kept (heredoc
    // redirects are owned by `collectHeredocBodies` instead): a `$` here is
    // live shell source.
    return { literal: hasLiveExpansionCharacter(node.text), expansions: [] };
  }
  if (node.type === "command_substitution" || node.type === "process_substitution") {
    // Outermost only: the inner text is parsed recursively by the expander,
    // which surfaces deeper levels. Eagerly nesting here multiplied work
    // exponentially (20-deep produced 250k segments); siblings are unaffected
    // because each site reports its own body through its own parent.
    const inner = substitutionBody(node);
    return {
      literal: true,
      expansions: inner === undefined ? [] : [inner],
    };
  }
  if (EXPANSION_NODES.has(node.type)) {
    const nested = node.children.map(scanExpansions);
    return {
      literal: true,
      expansions: nested.flatMap((scan) => scan.expansions),
    };
  }
  // A node that owns named children covers its own text with them, so the question is
  // answered per child. Reading the parent's raw text instead would re-count a `$` the
  // grammar already placed inside a `'…'` region, and `git push '${FLAG:--S}'` — inert
  // argv, and trusted by the shipped path — would come back as an unproven expansion.
  const named = node.children.filter((child) => child.isNamed);
  if (named.length > 0) {
    const nested = named.map(scanExpansions);
    return {
      literal: nested.some((scan) => scan.literal),
      expansions: nested.flatMap((scan) => scan.expansions),
    };
  }
  // A leaf: the only inert leaf above is `raw_string`, so `$` and backtick in the rest
  // of them is the text the shell will expand.
  return { literal: hasLiveExpansionCharacter(node.text), expansions: [] };
}

/**
 * Whether unquoted word text holds an expansion the shell will perform.
 * A backslash escapes the next character, which is what makes `echo a\$b` a literal
 * `a$b` rather than an unproven word.
 */
function hasLiveExpansionCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") index += 1;
    else if (character === "$" || character === "`") return true;
  }
  return false;
}

/** The text between a substitution's delimiters, or `undefined` when it has none. */
function substitutionBody(node: ShellAstNode): string | undefined {
  const opener = node.children.find((child) => !child.isNamed);
  const close = node.children[node.children.length - 1];
  if (!opener || !close || close.isNamed) return undefined;
  const body = node.text.slice(
    opener.endIndex - node.startIndex,
    close.startIndex - node.startIndex,
  );
  return body.trim() === "" ? undefined : body;
}
