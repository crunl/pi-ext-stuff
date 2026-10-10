/**
 * tree-sitter-bash AST front end.
 *
 * Phase 1 of the Shell AST migration. This module turns a parsed `bash` syntax tree
 * into the same per-segment input the segment fold in `shell-segment.ts` consumes
 * from the hand-written lexer: a source span, the argv words the shell would build,
 * and the lexical facts that decide whether the segment can be trusted. The fold then
 * makes every verdict, so "V1 and V2 agree on a segment" is decided by shared code
 * rather than by two copies that can drift.
 *
 * It holds no privileged I/O. The tree arrives through the injected
 * {@link ShellAstParser} because `tests/structure-invariants.test.ts` forbids
 * `node:fs` inside `src/permissions/`, while the grammar has to be read off disk by
 * the host bridge in `src/tree-sitter/`. `import type` never appears here at all:
 * `web-tree-sitter` is a bare specifier the engine's value graph must not gain.
 *
 * Two rules govern every branch below.
 *
 *  - **Never looser than the lexer.** The facts are the union of what the AST says and
 *    what `scanShellSyntax` says over the segment's own span, minus the two places
 *    the AST is provably better informed (an assignment value is not argv, an inert
 *    heredoc body is not live). Retiring the text scan is later-phase work, gated on
 *    the differential suite proving it redundant.
 *  - **Unmodelled syntax is not a judgement.** Anything this adapter cannot express as
 *    segments - a loop, a subshell, a `!` negation, a node type it does not know -
 *    returns `undefined` and the caller runs the lexer, which is the shipped
 *    behaviour. An ERROR node is different: it is modelled, and it fails closed.
 */
import {
  outermostSubstitutionBodies,
  scanShellSyntax,
  shellWords,
  splitShellSegments,
  splitShellText,
} from "./shell-lexer.ts";

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
 * What a front end must tell the fold about one segment.
 *
 * This is the only shape shared between the two front ends, and it is deliberately the
 * lexer's shape rather than the grammar's: the AST has to answer the same questions the
 * hand-written path answers, and nothing more, so `shell-segment.ts` needs no
 * front-end-specific knowledge in the fold.
 *
 * `lexIncomplete` collapses the lexer's `error`/`incomplete` pair — the fold only ever
 * asks "is this the whole word list" — and the AST sets it for a tree that carried an
 * error node, which is the same claim about the same text.
 */
export interface SegmentFacts {
  /** The raw command text this segment covers, delimiters trimmed. */
  source: string;
  /** The argv the shell would build: quotes stripped, redirects removed. */
  words: string[];
  /**
   * The text that ran is not the text that was read: the lexer's own
   * `error`/`incomplete` pair, an error region the grammar marked inside
   * the statement's tree, or a span recovered from an ERROR node. The
   * fold only ever asks "is this the whole word list".
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
    // A heredoc opener the grammar could not read whole (ERROR inside the
    // redirect — e.g. a queued `<<B` misparsed as `<` + file redirect) means
    // the grammar's body queue is untrustworthy: it invents commands from
    // body data. The character splitter queues heredocs correctly, so this
    // narrow class keeps its facts; everything else stays on the grammar.
    // (Step-3 work: a heredoc-aware pass over the AST so this partition can
    // retire with the lexer.)
    if (out.statements.some(statementHasBrokenHeredoc)) {
      return {
        segments: splitShellText(source).segments.map(lexFallbackFacts),
        hadError,
      };
    }
    // Heredoc bodies are data, never commands. Error recovery can materialize
    // body lines (or delimiter fragments) as statements — drop any statement
    // starting inside a body span. A non-bare delimiter line (`EOF && git
    // push`) never closes in real bash: the body runs to end of source, so
    // everything after the opener is data and is dropped, and the opener is
    // incomplete by construction.
    dropHeredocBodyStatements(source, out);
    const ordered: OrderedSegment[] = [];
    for (const statement of out.statements) {
      const segment = buildSegment(source, statement);
      if (segment) ordered.push({ order: statement.start, segment });
    }
    // A comment is content the lexer hands to the fold as its own segment. Emitting it
    // here is what keeps the two front ends agreeing on `# lead` + `echo hi`; dropping
    // it would shorten the segment list, and the caller's alignment check treats a
    // shortened list as an abstention rather than as a command with less in it.
    for (const comment of out.comments) {
      const text = comment.text.trim();
      if (text) ordered.push({ order: comment.startIndex, segment: lexSegment(text) });
    }
    if (hadError) addErrorSegments(out.errors, out.statements, ordered);
    if (hadError && !ordered.length && source.trim()) {
      ordered.push({ order: 0, segment: lexSegment(source.trim()) });
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
      last.redirects.push(
        ...node.namedChildren.filter((child) => REDIRECT_NODES.has(child.type)),
      );
      last.end = node.endIndex;
      return true;
    }
    const statement = redirectedStatement(node);
    if (!statement) return false;
    statements.push(statement);
    return true;
  }
  if (!hasModelledArgv(node)) return false;
  statements.push({
    command: node,
    redirects: redirectChildren(node),
    start: node.startIndex,
    end: node.endIndex,
  });
  return true;
}

function sameLine(source: string, from: number, to: number): boolean {
  return !source.slice(from, to).includes("\n");
}

/** Whether a statement's heredoc queue is untrustworthy (grammar error recovery). */
function statementHasBrokenHeredoc(statement: StatementInfo): boolean {
  return (
    statement.command?.hasError === true ||
    statement.redirects.some(
      (redirect) => redirect.type === "heredoc_redirect" && redirect.hasError,
    )
  );
}

/**
 * Splitter facts for one chunk, used only by the broken-heredoc fallback
 * above: the splitter owns the heredoc body queue, so its chunks are the
 * argv the shell runs. Identical in shape to what `buildSegment` produces
 * for a clean statement, minus grammar attribution.
 */
function lexFallbackFacts(source: string): SegmentFacts {
  const lexed = shellWords(source);
  const syntax = scanShellSyntax(source);
  return {
    source,
    words: lexed.words,
    lexIncomplete: lexed.error !== undefined || lexed.incomplete !== undefined,
    hasExecutableSubstitution: syntax.hasExecutableSubstitution,
    hasActiveRedirect: syntax.hasActiveRedirect,
    hasHereDocument: syntax.hasHereDocument,
    heredocExpansionRisk: false,
    // Outermost only — deeper levels surface through recursion (see above).
    bodies: outermostSubstitutionBodies(source),
  };
}

/**
 * Drop statements the grammar recovered from heredoc body data, in place.
 *
 * Two shapes. A body span (`heredoc_body` through its delimiter line) owns
 * its lines: any *other* statement starting inside one is data, not code.
 * And a delimiter line that is not the bare delimiter never closes in real
 * bash — the body runs to end of source — so every statement after the opener
 * is data, and the opener is marked by extending its end to end-of-source
 * (its span then covers the data, and `buildSegment` reads the words from
 * the grammar's argv, not from the body text).
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
    for (const piece of splitShellSegments(text)) {
      ordered.push({
        order: node.startIndex,
        // An error region is text the grammar could not read, so
        // the segment is incomplete by construction, however
        // cleanly the lexer tokenizes it: `$(` names an
        // unclosed substitution the word scan does not model as
        // a lex defect.
        segment: { ...lexSegment(piece), lexIncomplete: true },
      });
    }
  }
}

/**
 * A segment rendered by the lexer rather than the AST, for text the AST does not
 * model: a recovered error span or an out-of-model comment.
 *
 * Heredoc body lines are not among those spans. The heredoc-aware splitter keeps a
 * body inside the opener's segment, and this front end reads a body only in
 * `collectSubstitutions`'s `heredoc_body` branch. Whether body text is reviewed as
 * its own payload is still a phase-2 decision; none of the call sites here receive
 * a body line.
 */
function lexSegment(source: string): SegmentFacts {
  const lexed = shellWords(source);
  const syntax = scanShellSyntax(source);
  return {
    source,
    words: lexed.words,
    lexIncomplete: lexed.error !== undefined || lexed.incomplete !== undefined,
    hasExecutableSubstitution: syntax.hasExecutableSubstitution,
    hasActiveRedirect: syntax.hasActiveRedirect,
    hasHereDocument: syntax.hasHereDocument,
    // Never computed by a span-local scan: liveness runs over the chunk's
    // pending heredocs and their bodies, which only the command-line walk
    // (`splitShellText`) owns. `parseSegmentsAtDepth` stamps it on.
    heredocExpansionRisk: false,
    bodies: syntax.liveSubstitutions,
  };
}

/**
 * The segment for one statement: text, argv, and facts.
 *
 * `source` is the statement's own span, so the text scan sees exactly this command
 * rather than the whole line - which is why a `|` inside quotes no longer shreds a
 * segment, and why `cd '${D}' && git push` keeps the `cd` target literal instead of
 * reading the quotes as shell syntax.
 */
function buildSegment(source: string, statement: StatementInfo): SegmentFacts | undefined {
  const text = source.slice(statement.start, statement.end).trim();
  if (!text) return undefined;
  const words: string[] = [];
  const command = statement.command;
  if (command) {
    if (
      command.type === "declaration_command" ||
      command.type === "test_command" ||
      command.type === "variable_assignment"
    ) {
      // Anonymous nodes the per-child walk would shred: the declaration
      // builtin (`export`), the test brackets, and the `=` inside an
      // assignment (`FOO=1` split into `FOO` + `1` names a program `foo`).
      // The statement text here is the command alone (redirects are siblings),
      // so the lexer's own word split names the argv exactly.
      words.push(...dequote(command.text));
    } else if (
      command.type === "command" &&
      !command.children.some(
        (child) => child.isNamed && REDIRECT_NODES.has(child.type),
      )
    ) {
      // Whole-text split so a line continuation (`r\` + newline + `m` = `rm`,
      // which the shell joins before word-splitting) is not shredded at the
      // grammar's child boundary into `r` + `m` — a missed forced deletion.
      // Redirect-bearing commands keep the per-child walk so operators never
      // leak into argv.
      words.push(...dequote(command.text));
    } else {
      for (const child of command.children) {
        if (!child.isNamed || child.isError || child.isMissing) continue;
        if (REDIRECT_NODES.has(child.type) || child.type === "comment") continue;
        words.push(...dequote(child.text));
      }
    }
  }
  for (const redirect of statement.redirects) words.push(...redirectWords(redirect));
  if (statement.comment) words.push(...dequote(statement.comment.text));
  if (words.length > MAX_SEGMENT_WORDS) return undefined;
  const lexed = shellWords(text);
  const baseline = scanShellSyntax(text);
  const substitutions = collectSubstitutions(statement);
  // Active heredoc bodies run their substitutions (the shell re-reads the
  // body), so their live bodies join the expansion set directly from the
  // grammar — no splitter merge needed, at any nesting depth or queue
  // position. Inert (quoted/escaped-delimiter) bodies are literal text.
  const heredoc = collectHeredocBodies(statement);
  const bodies = [...new Set([...substitutions.bodies, ...heredoc.bodies])];
  return {
    source: text,
    words,
    // The statement's own scan, plus the one thing that scan cannot
    // see: an error region the grammar marked inside the statement's
    // own tree. Both mean the text that ran is not the text that was
    // read, however cleanly the lexer tokenizes the span.
    lexIncomplete:
      lexed.error !== undefined || lexed.incomplete !== undefined || statementHasError(statement),
    hasExecutableSubstitution:
      baseline.hasExecutableSubstitution ||
      substitutions.substitution ||
      heredoc.substitution ||
      liveAssignments(command),
    hasActiveRedirect: baseline.hasActiveRedirect || statement.redirects.length > 0,
    hasHereDocument: baseline.hasHereDocument || hereDocuments(statement.redirects),
    heredocExpansionRisk: heredoc.expansionRisk,
    bodies,
  };
}

/**
 * The live substitution bodies inside a statement's own active heredoc
 * bodies, plus whether any active body carries expansion characters.
 *
 * Mirrors the splitter's active/inert rule on the grammar's nodes: a quoted
 * or escaped delimiter (`<<'X'`, `<<"X"`, `<<\X`) makes the body literal;
 * a bare delimiter re-reads it. `heredoc_start` text carries the quotes, so
 * the first character decides — the same shapes `heredocDelimiterAt`
 * distinguishes, read off the parse instead of re-derived from text.
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
 * an error and the fold answers exactly the way the lexer does.
 */
function statementHasError(statement: StatementInfo): boolean {
  return (
    statement.command?.hasError === true ||
    statement.redirects.some((redirect) => redirect.hasError) ||
    statement.comment?.hasError === true
  );
}

/** Word text with the quotes the shell would remove, using the lexer's own rules. */
function dequote(chunk: string): string[] {
  return shellWords(chunk).words;
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
  // (The old slice(1) kept body/end words — a false-positive forced deletion
  // on every heredoc whose body named `rm`.)
  if (redirect.type === "heredoc_redirect" || redirect.type === "herestring_redirect")
    return [];
  const operator = redirectOperator(redirect);
  if (operator && DESCRIPTOR_REDIRECTS.has(operator)) return [];
  const targets = redirect.namedChildren.filter(
    (child) => child.type !== "file_descriptor" && !child.isError && !child.isMissing,
  );
  // `heredoc_start` names the file the body is written from, and the body and its
  // delimiter line are text: the statement span already stopped at the operator.
  return targets.slice(1).flatMap((child) => dequote(child.text));
}

function redirectOperator(redirect: ShellAstNode): string | undefined {
  return redirect.children.find((child) => !child.isNamed && /^[<>&|]+/.test(child.text))?.text;
}

function hereDocuments(redirects: readonly ShellAstNode[]): boolean {
  return redirects.some((redirect) => redirect.type === "heredoc_redirect");
}

/**
 * Whether a statement's assignments expand, so their text is argv-bearing content the
 * lexer counted and the AST must not subtract.
 *
 * `FOO=$(whoami) bar` and `FOO="a b" bar` both set the variable from word splitting -
 * the value is argv - while `FOO='$(pwd)' bar` never expands, which is the one
 * subtraction this adapter makes from the lexer's facts.
 */
function liveAssignments(command: ShellAstNode | undefined): boolean {
  if (!command) return false;
  return command.children.some((child) => {
    if (child.type !== "variable_assignment") return false;
    const value = child.children.find((inner) => inner.isNamed && inner.type !== "variable_name");
    return value !== undefined && scanShellSyntax(value.text).hasExecutableSubstitution;
  });
}

interface SubstitutionScan {
  substitution: boolean;
  bodies: string[];
}

/**
 * The live expansions of a statement, in source order.
 *
 * Inert by the shell's own rules - a single-quoted region and a heredoc body behind a
 * quoted or escaped delimiter - is skipped, and an assignment value is included, because
 * `FOO=$(whoami) bar` does run that substitution. A body is reported once for the
 * statement, matching what the lexer's scan handed the expander.
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
    // An unquoted delimiter means the body expands, exactly as the lexer's scan said.
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
 * `a$b` rather than an unproven word. The shipped scan reads the same escape, so this
 * is the difference between the two front ends agreeing on argv and the AST inventing a
 * review for text that names its own value.
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
