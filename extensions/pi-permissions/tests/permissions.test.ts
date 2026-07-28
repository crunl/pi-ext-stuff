import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathAllowed } from "../src/permissions/paths.ts";
import { matchRules, type PermissionRequest } from "../src/permissions/rules.ts";
import { classifyRisk, normalizeToolCall } from "../src/permissions/risk.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function request(tool: string, command: string): PermissionRequest {
  return normalizeToolCall(tool, { command }, "/work/repo");
}

describe("path permissions", () => {
  it("rejects writes outside the workspace", async () => {
    const result = await isPathAllowed("/Users/example/.ssh/config", {
      cwd: "/work/repo",
      allowWrite: [".", "/tmp"],
      denyRead: ["~/.ssh"],
      denyWrite: [".env", "*.pem"],
      operation: "write",
    });

    expect(result.allowed).toBe(false);
  });

  it("allows ordinary workspace writes but denies default secret files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-"));
    temporaryDirectories.push(cwd);

    await expect(isPathAllowed("notes.txt", { cwd, allowWrite: ["."], denyRead: [".env", ".env.*", "*.pem", "*.key"], denyWrite: [".env", ".env.*", "*.pem", "*.key"], operation: "write" })).resolves.toMatchObject({ allowed: true });
    await expect(isPathAllowed(".env.local", { cwd, allowWrite: ["."], denyRead: [".env", ".env.*", "*.pem", "*.key"], denyWrite: [".env", ".env.*", "*.pem", "*.key"], operation: "write" })).resolves.toMatchObject({ allowed: false });
    await expect(isPathAllowed("deploy.key", { cwd, allowWrite: ["."], denyRead: [".env", ".env.*", "*.pem", "*.key"], denyWrite: [".env", ".env.*", "*.pem", "*.key"], operation: "read" })).resolves.toMatchObject({ allowed: false });
  });

  it("rejects a symlink write that escapes an allowed root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-permissions-outside-"));
    temporaryDirectories.push(cwd, outside);
    await mkdir(join(cwd, "workspace"));
    await writeFile(join(outside, "target.txt"), "outside");
    await symlink(outside, join(cwd, "workspace", "escape"));

    const result = await isPathAllowed("workspace/escape/target.txt", {
      cwd,
      allowWrite: ["workspace"],
      denyRead: [],
      denyWrite: [],
      operation: "write",
    });

    expect(result).toMatchObject({ allowed: false });
  });
});

describe("permission rules", () => {
  it("gives deny precedence over a narrower allow", () => {
    const match = matchRules(request("bash", "git push origin main"), [
      { action: "allow", tool: "bash", pattern: "git push origin main" },
      { action: "deny", tool: "bash", pattern: "git push*" },
    ]);

    expect(match?.action).toBe("deny");
  });

  it("uses case-sensitive tool names and ask before allow", () => {
    const match = matchRules(request("bash", "git status"), [
      { action: "allow", tool: "Bash", pattern: "*" },
      { action: "allow", tool: "bash", pattern: "*" },
      { action: "ask", tool: "bash", pattern: "git *" },
    ]);

    expect(match?.action).toBe("ask");
  });
});

describe("request normalization and risk", () => {
  it("does not classify a chained destructive command as read-only", () => {
    const req = normalizeToolCall("bash", { command: "git status && rm -rf build" }, "/work/repo");

    expect(classifyRisk(req)).toBe("REVIEW");
  });

  it("classifies deletion of the workspace root as hard", () => {
    expect(classifyRisk(normalizeToolCall("bash", { command: "rm -rf /work/repo" }, "/work/repo"))).toBe("HARD");
  });

  it.each([
    ["rg TODO src | head -20", "LOW"],
    ["cat README.md > copied.txt", "REVIEW"],
    ["bash -c 'git status'", "REVIEW"],
    ["git status $(whoami)", "REVIEW"],
    ["git push --force origin main", "HARD"],
    ["npm publish", "REVIEW"],
  ] as const)("classifies %s as %s", (command, expected) => {
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe(expected);
  });

  it.each([
    ["http://localhost:3000", "HARD"],
    ["http://10.0.0.4", "HARD"],
    ["http://169.254.169.254/latest/meta-data", "HARD"],
    ["https://example.com/docs", "LOW"],
  ] as const)("classifies WebFetch %s as %s", (url, expected) => {
    expect(classifyRisk(normalizeToolCall("WebFetch", { url }, "/work/repo"))).toBe(expected);
  });

  it("keeps WebSearch low risk", () => {
    expect(classifyRisk(normalizeToolCall("WebSearch", { query: "TypeScript" }, "/work/repo"))).toBe("LOW");
  });

  it("reviews writes outside the workspace", () => {
    expect(classifyRisk(normalizeToolCall("write", { path: "/tmp/outside.txt" }, "/work/repo"))).toBe("REVIEW");
  });

  it("treats project permission configuration writes as hard", () => {
    expect(classifyRisk(normalizeToolCall("edit", { path: ".pi/permissions.json" }, "/work/repo"))).toBe("HARD");
  });
});
