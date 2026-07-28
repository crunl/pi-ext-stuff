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

describe("path policy", () => {
  it("allows ordinary workspace files and denies default secrets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-"));
    temporaryDirectories.push(cwd);

    await expect(isPathAllowed("notes.txt", { cwd, allowWrite: ["."], denyRead: [".env", ".env.*", "*.pem", "*.key"], denyWrite: [".env", ".env.*", "*.pem", "*.key"], operation: "write" })).resolves.toMatchObject({ allowed: true });
    await expect(isPathAllowed(".env.local", { cwd, allowWrite: ["."], denyRead: [".env", ".env.*", "*.pem", "*.key"], denyWrite: [".env", ".env.*", "*.pem", "*.key"], operation: "write" })).resolves.toMatchObject({ allowed: false });
    await expect(isPathAllowed("deploy.key", { cwd, allowWrite: ["."], denyRead: [".env", ".env.*", "*.pem", "*.key"], denyWrite: [".env", ".env.*", "*.pem", "*.key"], operation: "read" })).resolves.toMatchObject({ allowed: false });
  });

  it("rejects a symlink escape from an allowed write root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-permissions-outside-"));
    temporaryDirectories.push(cwd, outside);
    await mkdir(join(cwd, "workspace"));
    await writeFile(join(outside, "target.txt"), "outside");
    await symlink(outside, join(cwd, "workspace", "escape"));

    await expect(isPathAllowed("workspace/escape/target.txt", { cwd, allowWrite: ["workspace"], denyRead: [], denyWrite: [], operation: "write" })).resolves.toMatchObject({ allowed: false });
  });

  it("protects project permission configuration through a symlink", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-"));
    temporaryDirectories.push(cwd);
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, "control.json"), "{}");
    await symlink("../control.json", join(cwd, ".pi", "permissions.json"));

    await expect(isPathAllowed(".pi/permissions.json", { cwd, allowWrite: ["."], denyRead: [], denyWrite: [], operation: "write" })).resolves.toMatchObject({ allowed: false });
  });
});

describe("permission rules", () => {
  it("gives deny precedence and matches across newlines", () => {
    const match = matchRules(request("bash", "git status\ngit push origin main"), [
      { action: "allow", tool: "bash", pattern: "*" },
      { action: "deny", tool: "bash", pattern: "git status*git push*" },
    ]);

    expect(match?.action).toBe("deny");
  });
});

describe("narrow static risk contract", () => {
  it.each(["Read", "Search", "WebSearch"])("keeps native %s low risk", (tool) => {
    expect(classifyRisk(normalizeToolCall(tool, { path: "README.md", query: "permissions" }, "/work/repo"))).toBe("LOW");
  });

  it("keeps public WebFetch low and private WebFetch hard", () => {
    expect(classifyRisk(normalizeToolCall("WebFetch", { url: "https://example.com/docs" }, "/work/repo"))).toBe("LOW");
    expect(classifyRisk(normalizeToolCall("WebFetch", { url: "http://[::1]/" }, "/work/repo"))).toBe("HARD");
  });

  it("keeps ordinary workspace writes low", () => {
    expect(classifyRisk(normalizeToolCall("write", { path: "notes.txt" }, "/work/repo"))).toBe("LOW");
    expect(classifyRisk(normalizeToolCall("edit", { path: ".pi/permissions.json" }, "/work/repo"))).toBe("HARD");
  });

  it.each([
    ["pwd", "LOW"],
    ["ls -la", "LOW"],
    ["cat README.md", "LOW"],
    ["grep -rn TODO src", "LOW"],
    ["rg --no-config TODO src", "LOW"],
    ["rg -- --no-config src", "REVIEW"],
    ["/tmp/cat README.md", "REVIEW"],
    ["npm test", "REVIEW"],
  ] as const)("classifies simple Bash %s as %s", (command, expected) => {
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe(expected);
  });

  it.each([
    ["cat 'README.md'", "HARD"],
    ["cat README\\.md", "HARD"],
    ["cat README.md; pwd", "HARD"],
    ["cat README.md && pwd", "HARD"],
    ["cat README.md || pwd", "HARD"],
    ["cat README.md | wc", "HARD"],
    ["cat README.md &", "HARD"],
    ["cat README.md\npwd", "HARD"],
    ["cat README.md > copy.txt", "HARD"],
    ["cat $(pwd)", "HARD"],
    ["bash -c 'pwd'", "HARD"],
    ["rm -rf build", "HARD"],
    ["git push origin feature", "HARD"],
    ["curl https://example.com", "HARD"],
    ["npm publish", "HARD"],
    ["kubectl delete deployment production", "HARD"],
  ] as const)("makes complex or dangerous Bash %s hard", (command, expected) => {
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe(expected);
  });
});
