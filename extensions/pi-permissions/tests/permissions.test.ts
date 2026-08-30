import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPermissionsConfigPath } from "../src/filesystem-policy.ts";
import { isPathAllowed } from "../src/permissions/paths.ts";
import {
  classifyRisk,
  extractShellNetworkHosts,
  isPublicNetworkHost,
  normalizeToolCall,
  shellCommandCanGrantGitMetadata,
  shellCommandUsesDirectImplicitGitPush,
  shellCommandUsesGitMutation,
} from "../src/permissions/risk.ts";
import { matchRules, type PermissionRequest } from "../src/permissions/rules.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function request(tool: string, command: string): PermissionRequest {
  return normalizeToolCall(tool, { command }, "/work/repo");
}

describe("path policy", () => {
  it("allows ordinary workspace files and denies default secrets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-"));
    temporaryDirectories.push(cwd);

    await expect(
      isPathAllowed("notes.txt", {
        cwd,
        allowWrite: ["."],
        denyRead: [".env", ".env.*", "*.pem", "*.key"],
        denyWrite: [".env", ".env.*", "*.pem", "*.key"],
        operation: "write",
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      isPathAllowed(".env.local", {
        cwd,
        allowWrite: ["."],
        denyRead: [".env", ".env.*", "*.pem", "*.key"],
        denyWrite: [".env", ".env.*", "*.pem", "*.key"],
        operation: "write",
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      isPathAllowed("deploy.key", {
        cwd,
        allowWrite: ["."],
        denyRead: [".env", ".env.*", "*.pem", "*.key"],
        denyWrite: [".env", ".env.*", "*.pem", "*.key"],
        operation: "read",
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("rejects a symlink escape from an allowed write root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-permissions-outside-"));
    temporaryDirectories.push(cwd, outside);
    await mkdir(join(cwd, "workspace"));
    await writeFile(join(outside, "target.txt"), "outside");
    await symlink(outside, join(cwd, "workspace", "escape"));

    await expect(
      isPathAllowed("workspace/escape/target.txt", {
        cwd,
        allowWrite: ["workspace"],
        denyRead: [],
        denyWrite: [],
        operation: "write",
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("treats a project permissions file as an ordinary workspace file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-"));
    temporaryDirectories.push(cwd);
    await mkdir(join(cwd, ".pi"));

    await expect(
      isPathAllowed(".pi/permissions.json", {
        cwd,
        allowWrite: ["."],
        denyRead: [],
        denyWrite: [],
        operation: "write",
      }),
    ).resolves.toMatchObject({ allowed: true });
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

describe("Git metadata eligibility", () => {
  it.each([
    "git -C child commit -am update",
    "git --git-dir ../repo.git commit -am update",
    "git --git-dir=../repo.git commit -am update",
    "git --work-tree ../tree commit -am update",
    "git --work-tree=../tree commit -am update",
    "git -c core.hooksPath=/tmp/hooks commit -am update",
    "git --config-env=core.hooksPath=HOOKS commit -am update",
    "git --unknown-global commit -am update",
    "git -C child --unknown-global push origin main",
  ])("recognizes but cannot grant metadata for unsafe Git global options in %s", (command) => {
    expect(shellCommandUsesGitMutation(command)).toBe(true);
    expect(shellCommandCanGrantGitMetadata(command)).toBe(false);
  });

  it("allows a known value-free Git global option", () => {
    expect(shellCommandUsesGitMutation("git --no-pager commit -am update")).toBe(true);
    expect(shellCommandCanGrantGitMetadata("git --no-pager commit -am update")).toBe(true);
  });

  it.each([
    "./git commit -am update",
    "/tmp/git commit -am update",
    "./gh pr checkout 123",
    "PATH=/tmp git commit -am update",
    "env PATH=/tmp git commit -am update",
    "GIT_DIR=/tmp/repo.git git add README.md",
    "env GIT_WORK_TREE=/tmp/tree git add README.md",
    "env -C /tmp git add README.md",
    "sudo -C /tmp git push origin main",
    "sudo --chdir /tmp git push origin main",
  ])("recognizes but cannot grant metadata through an untrusted Git context in %s", (command) => {
    expect(shellCommandUsesGitMutation(command)).toBe(true);
    expect(shellCommandCanGrantGitMetadata(command)).toBe(false);
  });

  it.each([
    "git add README.md",
    "gh pr checkout 123",
    "/usr/bin/git add README.md",
    "X=1 git add README.md",
    "env X=1 git add README.md",
    "command git add README.md",
    "sudo -u root git add README.md",
  ])("keeps a trusted Git executable context eligible in %s", (command) => {
    expect(shellCommandUsesGitMutation(command)).toBe(true);
    expect(shellCommandCanGrantGitMetadata(command)).toBe(true);
  });

  it.each([
    "git add README.md &",
    "(git add README.md)",
    "; git add README.md",
    "git add README.md;",
    "| git add README.md",
    "git add README.md |",
    "\ngit add README.md",
    "git add README.md\n",
  ])("rejects active top-level shell control syntax in %s", (command) => {
    expect(shellCommandUsesGitMutation(command)).toBe(true);
    expect(shellCommandCanGrantGitMetadata(command)).toBe(false);
  });

  it.each([
    "git commit -m 'background & group (safe); pipe |'",
    'git commit -m "background & group (safe); pipe |"',
    "git add README\\&copy.md",
    "git add README\\(copy\\).md",
  ])("keeps quoted or escaped shell control literals eligible in %s", (command) => {
    expect(shellCommandCanGrantGitMetadata(command)).toBe(true);
  });

  it.each([
    ['git commit -m "document bash support"', true],
    ["git add docs/fish.md", true],
    ["git init", true],
    ["git init .", true],
    ['git init ""', false],
    ["git init ''", false],
    ["git init elsewhere", false],
    ["git init --bare", false],
    ['bash -c "git add README.md"', false],
    ['git add "$(printf README.md)"', false],
    ['git add "$' + '{ touch .git/hooks/pre-commit; }"', false],
    ['git add "$' + '{| touch .git/hooks/pre-commit; }"', false],
    ['git add "$' + '{variable}"', true],
    ["git add '$" + "{ touch .git/hooks/pre-commit; }'", true],
    ['git add "\\$' + '{ touch .git/hooks/pre-commit; }"', true],
    ["git add '$" + "{| touch .git/hooks/pre-commit; }'", true],
    ['git add "\\$' + '{| touch .git/hooks/pre-commit; }"', true],
    ["git add README.md > result.txt", false],
  ] as const)("decides Git metadata eligibility for %s", (command, expected) => {
    expect(shellCommandCanGrantGitMetadata(command)).toBe(expected);
  });

  it.each([
    ["git push origin main", true],
    ["/usr/bin/git push origin main", true],
    ["env git push origin main", true],
    ["command git push origin main", true],
    ["sudo -u root git push origin main", true],
    ["X=1 git push origin main", true],
    ["git fetch origin", false],
    ["git push https://github.com/owner/repo.git main", false],
    ['bash -c "git push origin main"', false],
    ["git push origin main; git status", false],
    ["git push origin main > push.log", false],
  ] as const)("identifies one parsed implicit Git push in %s", (command, expected) => {
    expect(shellCommandUsesDirectImplicitGitPush(command)).toBe(expected);
  });
});

describe("narrow static risk contract", () => {
  it.each(["Read", "Search", "WebSearch"])("keeps native %s low risk", (tool) => {
    expect(
      classifyRisk(
        normalizeToolCall(tool, { path: "README.md", query: "permissions" }, "/work/repo"),
      ),
    ).toBe("LOW");
  });

  it("keeps public WebFetch low and fails closed for invalid targets", () => {
    expect(
      classifyRisk(
        normalizeToolCall("WebFetch", { url: "https://example.com/docs" }, "/work/repo"),
      ),
    ).toBe("LOW");
    for (const input of [
      {},
      { url: "" },
      { url: "file:///etc/passwd" },
      { url: "ftp://example.com" },
    ]) {
      expect(classifyRisk(normalizeToolCall("WebFetch", input, "/work/repo"))).toBe("HARD");
    }
  });

  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://169.254.1.1/",
    "http://192.0.0.1/",
    "http://192.0.2.1/",
    "http://198.18.0.1/",
    "http://198.19.255.254/",
    "http://198.51.100.1/",
    "http://203.0.113.1/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://[::1]/",
    "http://[::127.0.0.1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fe80::1]/",
    "http://[ff00::1]/",
  ])("makes special-use target %s hard", (url) => {
    expect(classifyRisk(normalizeToolCall("WebFetch", { url }, "/work/repo"))).toBe("HARD");
  });

  it.each([
    "192.0.1.1",
    "192.88.99.1",
    "198.52.100.1",
    "203.0.114.1",
    "2001:db8::1",
    "2001:2::1",
    "2002:7f00:1::",
    "64:ff9b::127.0.0.1",
    "64:ff9b:1::127.0.0.1",
  ])("keeps Codex-public target %s public", (host) => {
    expect(isPublicNetworkHost(host)).toBe(true);
  });

  it("keeps ordinary workspace writes low", () => {
    expect(classifyRisk(normalizeToolCall("write", { path: "notes.txt" }, "/work/repo"))).toBe(
      "LOW",
    );
    expect(
      classifyRisk(normalizeToolCall("edit", { path: ".pi/permissions.json" }, "/work/repo")),
    ).toBe("LOW");
    expect(
      classifyRisk(
        normalizeToolCall(
          "edit",
          {
            path: defaultPermissionsConfigPath(),
          },
          "/work/repo",
        ),
      ),
    ).toBe("HARD");
    expect(
      classifyRisk(
        normalizeToolCall(
          "write",
          { path: "/opt/pi/extensions/pi-permissions/config.json" },
          "/work",
        ),
        false,
        [],
        ["/opt/pi/extensions/pi-permissions/config.json"],
      ),
    ).toBe("HARD");
  });

  it.each([
    ["pwd", "LOW"],
    ["ls -la", "LOW"],
    ["cat README.md", "LOW"],
    ["grep -rn TODO src", "LOW"],
    ["rg --no-config TODO src", "LOW"],
    ["rg -- --no-config src", "LOW"],
    ["/tmp/cat README.md", "LOW"],
    ["npm test", "LOW"],
    ["kubectl version", "LOW"],
    ["terraform version", "LOW"],
    ["helm version", "LOW"],
    ["ansible --version", "LOW"],
  ] as const)("classifies simple Bash %s as %s", (command, expected) => {
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe(expected);
  });

  it.each([
    ["cat 'README.md'", "LOW"],
    ["cat README\\.md", "LOW"],
    ["cat README.md; pwd", "LOW"],
    ["cat README.md && pwd", "LOW"],
    ["cat README.md || pwd", "LOW"],
    ["cat README.md | wc", "LOW"],
    ["cat README.md &", "LOW"],
    ["cat README.md\npwd", "LOW"],
    ["cat README.md > copy.txt", "LOW"],
    ["cat $(pwd)", "REVIEW"],
    ["bash -c 'pwd'", "LOW"],
    ["rm -rf build", "HARD"],
    ["rm --force build", "HARD"],
    ["rm -f build/a.ts", "HARD"],
    ["sudo rm -rf build", "HARD"],
    ["env -i rm -rf build", "HARD"],
    ["trap 'rm -rf /tmp/x' EXIT", "HARD"],
    ['bash -lc "rm -rf build"', "HARD"],
    ['sh -c "rm -f x"', "HARD"],
    ["trap 'ls' EXIT", "LOW"],
    ["rm -r build", "LOW"],
    ["rm build/a.ts", "LOW"],
    ["rmdir build/cache", "LOW"],
    ["unlink build/a.ts", "LOW"],
    ["shred build/a.ts", "LOW"],
    ["truncate -s 0 build/a.ts", "LOW"],
    ["rm -- -f build", "LOW"],
    ["git push origin feature", "HARD"],
    ["curl https://example.com", "HARD"],
    ["npm publish", "HARD"],
    ["kubectl delete deployment production", "HARD"],
    ["FOO=bar cat README.md", "LOW"],
    ["cat *.md", "LOW"],
    ["cat {README,LICENSE}", "LOW"],
    ["cat #comment", "LOW"],
    ["cat (README.md)", "LOW"],
    ["cat ~/README.md", "LOW"],
    ["cat !README.md", "LOW"],
    ["cat ?README.md", "LOW"],
    ["cat [README].md", "LOW"],
  ] as const)("classifies sandboxed Bash %s as %s", (command, expected) => {
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe(expected);
  });

  it.each(['echo "$(rm -rf build)"', "echo `rm -rf build`"])(
    "requires review for executable shell substitution in %s",
    (command) => {
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe("REVIEW");
    },
  );

  it.each([
    "printf '%s\\n' '$(rm -rf build)'",
    "printf '%s\\n' '`rm -rf build`'",
    "printf '%s\\n' \\$HOME",
  ])("keeps inert shell substitution syntax low risk in %s", (command) => {
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe("LOW");
  });

  it("extracts one-time public network hosts from shell commands", () => {
    expect(
      extractShellNetworkHosts("curl https://example.com/a && ssh user@build.example.org"),
    ).toEqual(["example.com", "build.example.org"]);
    expect(
      extractShellNetworkHosts("scp ./artifact.tgz deploy@uploads.example.net:/srv/releases/"),
    ).toEqual(["uploads.example.net"]);
    expect(isPublicNetworkHost("example.com")).toBe(true);
    expect(isPublicNetworkHost("127.0.0.1")).toBe(false);
    expect(isPublicNetworkHost("service.localhost")).toBe(false);
  });

  it.each(["127.1", "2130706433", "0x7f000001"])(
    "rejects ambiguous numeric network host %s",
    (host) => {
      expect(isPublicNetworkHost(host)).toBe(false);
    },
  );
});
