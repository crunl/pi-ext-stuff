import type { PermissionsConfig } from "./config.ts";
import { isPathAllowed } from "./permissions/paths.ts";
import { classifyRisk, normalizeToolCall, type Risk } from "./permissions/risk.ts";
import { matchRules } from "./permissions/rules.ts";

export type DefaultDecision =
  | { action: "allow"; risk: Risk; reason: string }
  | { action: "prompt"; risk: Risk; reason: string; summary: string }
  | { action: "block"; risk: Risk; reason: string };

function summarize(tool: string, input: Record<string, unknown>): string {
  const limit = (value: string) => value.replace(/[\r\n\t]+/g, " ").slice(0, 500);
  if (typeof input.command === "string") return limit(input.command);
  if (typeof input.path === "string") return limit(input.path);
  if (typeof input.filePath === "string") return limit(input.filePath);
  if (typeof input.url === "string") return limit(input.url);
  if (typeof input.query === "string") return limit(input.query);
  const safeKeys = Object.keys(input).filter((key) => ![
    "content",
    "oldText",
    "newText",
    "patch",
    "data",
  ].includes(key));
  return safeKeys.length > 0 ? `${tool} (${safeKeys.join(", ")})` : tool;
}

function pathOperation(operation: string): "read" | "write" | undefined {
  if (operation === "read") return "read";
  if (operation === "write") return "write";
  return undefined;
}

export async function evaluateDefaultRequest(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  config: PermissionsConfig,
): Promise<DefaultDecision> {
  const request = normalizeToolCall(tool, input, cwd);
  const rule = matchRules(request, config.rules);
  if (rule?.action === "deny") {
    return { action: "block", risk: "HARD", reason: "Denied by permissions rule" };
  }

  let risk = classifyRisk(request);
  const operation = pathOperation(request.operation);
  if (operation) {
    for (const path of request.resolvedPaths) {
      const decision = await isPathAllowed(path, {
        cwd,
        allowWrite: config.sandbox.filesystem.allowWrite,
        denyRead: config.sandbox.filesystem.denyRead,
        denyWrite: config.sandbox.filesystem.denyWrite,
        operation,
      });
      if (decision.allowed) continue;
      if (decision.reason === "write path is outside allowed roots") {
        risk = risk === "HARD" ? "HARD" : "REVIEW";
        continue;
      }
      return { action: "block", risk: "HARD", reason: decision.reason };
    }
  }

  if (rule?.action === "allow" && risk !== "HARD") {
    return { action: "allow", risk, reason: "Allowed by permissions rule" };
  }

  if (rule?.action === "ask" || risk !== "LOW") {
    return {
      action: "prompt",
      risk,
      reason: rule?.action === "ask" ? "Approval required by permissions rule" : `${risk} operation`,
      summary: summarize(tool, input),
    };
  }

  return { action: "allow", risk, reason: "Low-risk operation" };
}
