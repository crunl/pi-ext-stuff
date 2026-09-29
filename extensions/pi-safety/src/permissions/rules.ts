/**
 * Programs whose arguments name things to remove. Lives here rather than in
 * `risk.ts` so `cd-normalize.ts` can consult the same list without importing
 * its own consumer: the three modules form no cycle through this one.
 */
export const deletionExecutables = new Set(["rm", "rmdir", "unlink", "shred", "truncate"]);

export interface PermissionRule {
  action: "allow" | "ask" | "deny";
  tool: string;
  pattern?: string;
}

export interface PermissionRequest {
  tool: string;
  operation: "read" | "write" | "execute" | "network" | "external";
  input: Record<string, unknown>;
  cwd: string;
  resolvedPaths: string[];
  commandSegments?: CommandSegment[];
  networkTargets?: string[];
}

/**
 * Which clause of the decomposable conjunction failed first, named by the
 * mechanism that failed — never by the disposition it produced. The
 * `risk_not_low` rename (docs/research/2026-09-25-disposition-vocabulary-alignment.md)
 * is why: a tag that names a disposition lies the next time the disposition
 * vocabulary moves. `lex_incomplete` covers lex error, incomplete input, a
 * nameless command word, and an unreduced brace group.
 */
export type SegmentUnprovenCause =
  | "lex_incomplete"
  | "wrapper_unreduced"
  | "nested_git_program"
  | "command_word_unproven"
  | "program_reinterpreted"
  | "substitution_unproven"
  | "heredoc_unproven";

export interface CommandSegment {
  source: string;
  /** Raw executable token before basename normalization. */
  executableToken: string;
  executable: string;
  /**
   * The resolved program is the one these words name: no `identity`-impacting
   * variable, no untrusted wrapper token. False means the program cannot be
   * identified at all.
   */
  executableTrusted: boolean;
  /**
   * The program is identified, but its surroundings are not fully proven — a
   * variable that changes context without changing the binary, or a wrapper
   * whose argument grammar could not be reduced. This is a review, and it is
   * independent of `executableTrusted` in both directions.
   */
  executableContextUntrusted: boolean;
  args: string[];
  hasRedirect: boolean;
  hasSubstitution: boolean;
  nestedShell: boolean;
  /**
   * Static argv equals the argv the shell will run: no dynamic executable
   * word, no re-interpreted string, no command substitution, no heredoc, no
   * brace group. Only a decomposable segment can be proven safe by inspection.
   */
  decomposable: boolean;
  /**
   * The first failed clause of the `decomposable` conjunction, recorded at the
   * fold itself so no consumer has to re-derive it and drift from it. Absent
   * exactly when `decomposable` is true. Observational: it co-stamps the
   * review, it never changes a disposition.
   */
  unprovenCause?: SegmentUnprovenCause;
}

export interface RuleMatch {
  action: PermissionRule["action"];
  rule: PermissionRule;
}

const actionRank: Record<PermissionRule["action"], number> = { allow: 1, ask: 2, deny: 3 };

function globMatches(value: string, pattern: string): boolean {
  const expression = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
  return new RegExp(`^${expression}$`).test(value);
}

function requestText(request: PermissionRequest): string {
  if (typeof request.input.command === "string") return request.input.command;
  if (request.commandSegments)
    return request.commandSegments.map((segment) => segment.source).join(" ");
  return JSON.stringify(request.input);
}

export function matchRules(
  request: PermissionRequest,
  rules: PermissionRule[],
): RuleMatch | undefined {
  const text = requestText(request);
  // tool matches by exact name or glob (e.g. "mcp__*" to cover MCP tools);
  // pattern, when present, matches the command text / input serialization.
  const matches = rules.filter(
    (rule) =>
      (rule.tool === request.tool || globMatches(request.tool, rule.tool)) &&
      (!rule.pattern || globMatches(text, rule.pattern)),
  );
  return matches.reduce<RuleMatch | undefined>((best, rule) => {
    if (!best || actionRank[rule.action] > actionRank[best.action])
      return { action: rule.action, rule };
    return best;
  }, undefined);
}
