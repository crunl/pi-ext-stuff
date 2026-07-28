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

export interface CommandSegment {
  source: string;
  /** Raw executable token before basename normalization. */
  executableToken: string;
  executable: string;
  args: string[];
  hasRedirect: boolean;
  hasSubstitution: boolean;
  nestedShell: boolean;
}

export interface RuleMatch {
  action: PermissionRule["action"];
  rule: PermissionRule;
}

const actionRank: Record<PermissionRule["action"], number> = { allow: 1, ask: 2, deny: 3 };

function globMatches(value: string, pattern: string): boolean {
  const expression = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, "[\\s\\S]*");
  return new RegExp(`^${expression}$`).test(value);
}

function requestText(request: PermissionRequest): string {
  if (typeof request.input.command === "string") return request.input.command;
  if (request.commandSegments) return request.commandSegments.map((segment) => segment.source).join(" ");
  return JSON.stringify(request.input);
}

export function matchRules(request: PermissionRequest, rules: PermissionRule[]): RuleMatch | undefined {
  const text = requestText(request);
  const matches = rules.filter((rule) => rule.tool === request.tool && (!rule.pattern || globMatches(text, rule.pattern)));
  return matches.reduce<RuleMatch | undefined>((best, rule) => {
    if (!best || actionRank[rule.action] > actionRank[best.action]) return { action: rule.action, rule };
    return best;
  }, undefined);
}
