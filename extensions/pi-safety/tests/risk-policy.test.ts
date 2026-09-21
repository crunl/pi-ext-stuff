import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SafetyConfig } from "../src/config.ts";
import { packageRoot } from "../src/filesystem-policy.ts";
import {
  evaluateHostFirstRulesOnly,
  evaluateHostRiskRequest,
  evaluateRiskRequest,
  isSupportedPermissionRequestShape,
} from "../src/risk-policy.ts";

function config(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
  };
}

async function createGitDirectory(path: string, contents = ""): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(path, "config"), contents);
  await mkdir(join(path, "objects"));
  await mkdir(join(path, "refs"));
}

describe("Permission request own-property shape", () => {
  function request() {
    return {
      scope: "turn",
      reason: "bounded access",
      permissions: {
        network: { hosts: ["narrow.example"] },
        filesystem: { write: ["/tmp/request-shape"] },
      },
    };
  }

  it.each(["hidden-hosts", "hidden-port"] as const)(
    "rejects clone-erased network constraints: %s",
    (shape) => {
      const network =
        shape === "hidden-hosts" ? { network_access: true } : { hosts: ["narrow.example"] };
      Object.defineProperty(network, shape === "hidden-hosts" ? "hosts" : "port", {
        value: shape === "hidden-hosts" ? ["narrow.example"] : 443,
        enumerable: false,
      });
      const input = { permissions: { network } };
      expect(isSupportedPermissionRequestShape(input)).toBe(false);
      // The clone alone is valid: the raw ingress check must precede capture.
      expect(isSupportedPermissionRequestShape(structuredClone(input))).toBe(true);
    },
  );

  // These descriptor forms are rejected for JSON-like schema consistency;
  // not every layer independently represents an authority-widening exploit.
  describe.each(["root", "permissions", "network", "filesystem", "hosts", "write"] as const)(
    "%s layer",
    (layer) => {
      it.each(["hidden", "accessor", "unknown", "hidden-unknown", "symbol"] as const)(
        "rejects %s own properties without invoking accessors",
        (form) => {
          const input = request();
          const [target, key, value] =
            layer === "root"
              ? [input, "scope", input.scope]
              : layer === "permissions"
                ? [input.permissions, "network", input.permissions.network]
                : layer === "network"
                  ? [input.permissions.network, "hosts", input.permissions.network.hosts]
                  : layer === "filesystem"
                    ? [input.permissions.filesystem, "write", input.permissions.filesystem.write]
                    : layer === "hosts"
                      ? [input.permissions.network.hosts, "0", "narrow.example"]
                      : [input.permissions.filesystem.write, "0", "/tmp/request-shape"];
          let reads = 0;
          if (form === "accessor") {
            Object.defineProperty(target, key, {
              enumerable: true,
              get: () => {
                reads += 1;
                return value;
              },
            });
          } else {
            Object.defineProperty(
              target,
              form === "symbol"
                ? Symbol("scope")
                : form === "unknown" || form === "hidden-unknown"
                  ? "unsupported"
                  : key,
              { value, enumerable: form === "unknown" || form === "symbol" },
            );
          }
          expect(isSupportedPermissionRequestShape(input)).toBe(false);
          expect(reads).toBe(0);
        },
      );
    },
  );

  it.each(["hosts", "write"] as const)("rejects sparse or custom-prototype %s lists", (key) => {
    const wrap = (list: string[]) => ({
      permissions: key === "hosts" ? { network: { hosts: list } } : { filesystem: { write: list } },
    });
    const sparse = new Array<string>(2);
    sparse[1] = "narrow.example";
    expect(isSupportedPermissionRequestShape(wrap(sparse))).toBe(false);
    const inherited = ["narrow.example"];
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { port: 443 }));
    expect(isSupportedPermissionRequestShape(wrap(inherited))).toBe(false);
  });

  it.each(["ordinary", "frozen", "null-prototype"] as const)(
    "preserves unambiguous %s data at every record and list layer",
    (form) => {
      const input = request();
      const records = [
        input,
        input.permissions,
        input.permissions.network,
        input.permissions.filesystem,
      ];
      const lists = [input.permissions.network.hosts, input.permissions.filesystem.write];
      if (form === "frozen") {
        for (const value of [...records, ...lists]) Object.freeze(value);
      }
      if (form === "null-prototype") {
        for (const value of records) Object.setPrototypeOf(value, null);
      }
      expect(isSupportedPermissionRequestShape(input)).toBe(true);
      expect(isSupportedPermissionRequestShape(structuredClone(input))).toBe(true);
      const broad = { permissions: { network: { network_access: true } } };
      for (const value of [broad, broad.permissions, broad.permissions.network]) {
        if (form === "frozen") Object.freeze(value);
        if (form === "null-prototype") Object.setPrototypeOf(value, null);
      }
      expect(isSupportedPermissionRequestShape(broad)).toBe(true);
    },
  );

  it("preserves empty ordinary lists for the later semantic permission check", () => {
    expect(isSupportedPermissionRequestShape({ permissions: { network: { hosts: [] } } })).toBe(
      true,
    );
  });
});

describe("Risk policy gate", () => {
  it("host-first B: empty rules never block; only deny does; ask is ignored", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-host-"));

    for (const [tool, input] of [
      ["read", { path: "README.md" }],
      ["WebFetch", { url: "http://127.0.0.1/internal" }],
      ["apply_patch", { path: "/outside/file", content: "updated" }],
      ["powershell", { command: "Remove-Item -Recurse C:\\\\workspace" }],
    ] as const) {
      await expect(evaluateHostRiskRequest(tool, input, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
      expect(evaluateHostFirstRulesOnly(tool, input, cwd, config())).toBeUndefined();
    }

    const askOnly = config({
      rules: [{ action: "ask", tool: "WebFetch", pattern: "*example.com*" }],
    });
    expect(
      evaluateHostFirstRulesOnly("WebFetch", { url: "https://example.com/docs" }, cwd, askOnly),
    ).toBeUndefined();
    await expect(
      evaluateHostRiskRequest("WebFetch", { url: "https://example.com/docs" }, cwd, askOnly),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });

    const denyRules = config({
      rules: [{ action: "deny", tool: "read", pattern: "*/Library/*" }],
    });
    expect(
      evaluateHostFirstRulesOnly(
        "read",
        { path: "/Users/example/Library/Preferences/x" },
        cwd,
        denyRules,
      ),
    ).toMatchObject({ block: true, reason: "Denied by permissions rule" });
    await expect(
      evaluateHostRiskRequest(
        "read",
        { path: "/Users/example/Library/Preferences/x" },
        cwd,
        denyRules,
      ),
    ).resolves.toMatchObject({ action: "block", risk: "HARD" });
  });

  it("allows ordinary workspace reads and writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    await expect(
      evaluateRiskRequest("read", { path: "README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(
      evaluateRiskRequest("write", { path: "notes.txt", content: "hello" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(
      evaluateRiskRequest("write", { path: ".pi/permissions.json", content: "{}" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("allows routine host tools, including MCP-style direct tool names", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    for (const tool of ["context7_resolve-library-id", "exa_web_search_exa", "tinyfish_search"]) {
      await expect(
        evaluateRiskRequest(tool, { query: "public docs" }, cwd, config()),
      ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    }
  });

  it("allows ordinary writes in the extension package root", async () => {
    await expect(
      evaluateRiskRequest(
        "write",
        { path: "p2-3-package-root.txt", content: "hello" },
        packageRoot,
        config(),
      ),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("does not add sensitive-file restrictions beyond Codex workspace-write", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    for (const path of [".env", "nested/.env", "nested/.env.local", "nested/deploy.key"]) {
      await expect(evaluateRiskRequest("read", { path }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
      await expect(
        evaluateRiskRequest("write", { path, content: "secret" }, cwd, config()),
      ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    }
  });

  it("keeps repository control directories read-only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    for (const path of [".git/config", ".agents/AGENTS.md", ".codex/config.toml"]) {
      await expect(
        evaluateRiskRequest("write", { path, content: "x" }, cwd, config()),
      ).resolves.toMatchObject({
        action: "block",
        reason: "permission control path is protected",
      });
    }
  });

  it.each(["git stash list", "compound current-worktree probe"] as const)(
    "keeps Git read-only probes ordinary LOW/SRT operations: %s",
    async (probe) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-git-readonly-"));
      const command =
        probe === "git stash list"
          ? probe
          : `cd ${cwd} && git status --short && git stash list | head -2; git log --oneline -1; git rev-parse --show-toplevel`;

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    },
  );

  it("treats the configured current directory as the writable workspace", async () => {
    const cwd = homedir();
    const models = resolve(cwd, ".pi/agent/models.json");
    await expect(
      evaluateRiskRequest(
        "edit",
        { path: models, edits: [{ oldText: "a", newText: "b" }] },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(
      evaluateRiskRequest("write", { path: "notes.txt", content: "x" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(
      evaluateRiskRequest(
        "write",
        { path: resolve("/tmp", "pi-home-ok.txt"), content: "x" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(
      evaluateRiskRequest(
        "request_permissions",
        { permissions: { filesystem: { write: [cwd] } }, scope: "turn" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "prompt",
      filesystemWriteRoots: [cwd],
    });
  });

  it("prompts for external writes and Codex-dangerous commands", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    await expect(
      evaluateRiskRequest("write", { path: "/var/tmp/out.txt", content: "x" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    await expect(
      evaluateRiskRequest("bash", { command: "rm -rf build" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "HARD" });
  });

  it("auto-runs ordinary shell syntax inside the sandbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    for (const command of [
      "npm test",
      "git status",
      "cat README.md | wc -l",
      "pnpm lint",
      "rg production",
      "git grep deploy",
      "npm run production",
      "printf 'git push'",
      "rg https://example.com",
      "gh --version",
      "curl --version",
    ]) {
      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    }
  });

  it("defers ordinary Bash network decisions to the runtime sandbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const cases = [
      [
        "gh issue comment 1 --body https://example.com",
        ["api.github.com", "github.com", "uploads.github.com"],
      ],
      ["gh pr edit 1 --title x", ["api.github.com", "github.com", "uploads.github.com"]],
      ["node -e \"fetch('https://api.github.com/repos')\"", ["api.github.com"]],
      ["python -c \"requests.get('https://example.com')\"", ["example.com"]],
      ["/usr/bin/curl https://example.com", ["example.com"]],
      ["env curl https://example.com", ["example.com"]],
      ["env -u HTTPS_PROXY curl https://example.com", ["example.com"]],
      ["sudo -u root curl https://example.com", ["example.com"]],
      ['bash -c "curl https://example.com"', ["example.com"]],
      ['bash -lc "curl https://example.com"', ["example.com"]],
      ["git clone https://github.com/openai/codex.git", ["github.com"]],
      ["npm install lodash", ["registry.npmjs.org"]],
    ] as const;

    for (const [command] of cases) {
      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    }
  });

  it("does not pregrant a parsed destination when a rule requests approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    const configured = config({
      rules: [{ action: "ask", tool: "bash", pattern: "curl *" }],
    });
    const decision = await evaluateRiskRequest(
      "bash",
      { command: "curl -X POST -H 'accept: application/json' https://example.com/api" },
      cwd,
      configured,
    );
    expect(decision).toMatchObject({
      action: "prompt",
      risk: "LOW",
    });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("keeps a Git remote on the exact runtime connection boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      '[remote "origin"]\n\turl = git@github.com:openai/codex.git\n',
    );

    const decision = await evaluateRiskRequest(
      "bash",
      { command: "git push origin main" },
      cwd,
      config(),
    );
    expect(decision).toMatchObject({ action: "allow", risk: "LOW" });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it.each([
    "git push origin main",
    "env git push origin main",
    "command git push origin main",
    "sudo -u root git push origin main",
    "X=1 git push origin main",
  ])("defers a private Git pushurl to the runtime boundary for %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      [
        '[remote "origin"]',
        "\turl = git@github.com:openai/codex.git",
        "\tpushurl = ssh://git@127.1/openai/codex.git",
        "",
      ].join("\n"),
    );

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "LOW",
    });
  });

  it.each(["git push origin HEAD:main", "git push --porcelain origin HEAD:main"])(
    "defers a private Git pushurl independently of the refspec for %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
      await createGitDirectory(
        join(cwd, ".git"),
        [
          '[remote "origin"]',
          "\turl = git@github.com:openai/codex.git",
          "\tpushurl = ssh://git@127.1/openai/codex.git",
          "",
        ].join("\n"),
      );

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    },
  );

  it.each([
    "git push ssh://git@127.1/owner/repo.git HEAD:main",
    "git push git://2130706433/owner/repo.git HEAD:main",
    "git push 0x7f000001:owner/repo.git HEAD:main",
  ])(
    "defers a private explicit Git remote operand to the runtime boundary in %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
      await createGitDirectory(join(cwd, ".git"));

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    },
  );

  it.each([
    "git push --repo=ssh://git@127.1/owner/repo.git -- HEAD:main",
    "git fetch --multiple https://github.com/openai/codex.git ssh://git@127.1/owner/repo.git",
    "git submodule add -b main ssh://git@127.1/owner/repo.git child",
  ])("defers private Git network targets to the runtime boundary in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "LOW",
    });
  });

  it("keeps unsupported Git remote helpers statically blocked", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateRiskRequest("bash", { command: "git fetch ext::/tmp/network-helper" }, cwd, config()),
    ).resolves.toMatchObject({ action: "block", risk: "HARD" });
  });

  it.each([
    "git push --repo=ssh://git@github.com/openai/codex.git -- HEAD:main",
    "git fetch --multiple https://github.com/openai/codex.git ssh://git@gitlab.com/openai/codex.git",
    "git submodule add -b main ssh://git@github.com/openai/codex.git child",
  ] as const)(
    "defers public Git remote operands to the runtime boundary in %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
      await createGitDirectory(join(cwd, ".git"));

      const decision = await evaluateRiskRequest("bash", { command }, cwd, config());
      expect(decision).toMatchObject({ action: "allow", risk: "LOW" });
      expect(decision).not.toHaveProperty("networkHosts");
    },
  );

  it("defers a public SSH Git remote to the runtime boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    const decision = await evaluateRiskRequest(
      "bash",
      { command: "git push ssh://git@github.com/openai/codex.git HEAD:main" },
      cwd,
      config(),
    );
    expect(decision).toMatchObject({ action: "allow", risk: "LOW" });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("keeps a local Git remote operand out of network policy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));
    await expect(
      evaluateRiskRequest("bash", { command: "git push ../local.git HEAD:main" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("fails closed when a Git remote option cannot be parsed reliably", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateRiskRequest(
        "bash",
        { command: "git push --future-option origin HEAD:main" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "block",
      risk: "HARD",
      reason: expect.stringContaining("Git network"),
    });
  });

  it("defers a public fetch URL to the runtime boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      [
        '[remote "origin"]',
        "\turl = git@github.com:openai/codex.git",
        "\tpushurl = ssh://git@127.1/openai/codex.git",
        "",
      ].join("\n"),
    );

    const decision = await evaluateRiskRequest(
      "bash",
      { command: "git fetch origin" },
      cwd,
      config(),
    );
    expect(decision).toMatchObject({ action: "allow", risk: "LOW" });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("does not mistake a fetch refspec for the remote operand", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      '[remote "origin"]\n\turl = git@github.com:openai/codex.git\n',
    );

    const decision = await evaluateRiskRequest(
      "bash",
      { command: "git fetch --prune origin HEAD:refs/remotes/origin/main" },
      cwd,
      config(),
    );
    expect(decision).toMatchObject({ action: "allow", risk: "LOW" });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("does not turn an explicit action review into a whole-command network grant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const configured = config({
      rules: [{ action: "ask", tool: "bash", pattern: "curl *" }],
    });

    const decision = await evaluateRiskRequest(
      "bash",
      { command: "curl https://example.com/docs" },
      cwd,
      configured,
    );
    expect(decision).toMatchObject({
      action: "prompt",
      risk: "LOW",
    });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("keeps Git mutations on the ordinary sandbox path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "allow",
      risk: "LOW",
    });
    const ghDecision = await evaluateRiskRequest(
      "bash",
      { command: "gh pr checkout 123" },
      cwd,
      config(),
    );
    expect(ghDecision).toMatchObject({ action: "allow", risk: "LOW" });
    expect(ghDecision).not.toHaveProperty("networkHosts");
    for (const command of [
      "git commit -m 'document input > output'",
      'git commit -m "document bash support"',
      "git add docs/fish.md",
      "git add '$" + "{ touch .git/hooks/pre-commit; }'",
      'git add "\\$' + '{ touch .git/hooks/pre-commit; }"',
      "git add '$" + "{| touch .git/hooks/pre-commit; }'",
      'git add "\\$' + '{| touch .git/hooks/pre-commit; }"',
    ]) {
      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    }
  });

  it.each([
    "git -C child commit -am update",
    "git --git-dir ../repo.git commit -am update",
    "git --work-tree ../tree commit -am update",
    "git -c core.hooksPath=/tmp/hooks commit -am update",
    "git --config-env=core.hooksPath=HOOKS commit -am update",
    "git --unknown-global commit -am update",
  ])("does not gate ordinary Git mutations on global-option parsing in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "LOW",
    });
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
  ])("does not gate ordinary Git mutations on executable identity in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "LOW",
    });
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
  ])("does not apply a single-command gate to Git shell composition in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "LOW",
    });
  });

  it.each(["git init", "git init ."])(
    "keeps Git init as an ordinary sandbox action for %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-git-init-"));

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    },
  );

  it("keeps Git init ordinary inside an existing parent repository", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-safety-parent-repository-"));
    const cwd = join(parent, "child");
    await createGitDirectory(join(parent, ".git"));
    await mkdir(cwd);
    await expect(
      evaluateRiskRequest("bash", { command: "git init" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "allow",
      risk: "LOW",
    });
  });

  it.each(['git init ""', "git init ''"])(
    "does not statically reject an ordinary Git init operand in %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-empty-git-init-"));

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    },
  );

  it("leaves missing-repository Git mutations to the ordinary sandbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-no-repository-"));

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it.each([
    "git add README.md; printf '#!/bin/sh\\n' > .git/hooks/pre-commit",
    "git add README.md > .git/hooks/pre-commit",
    'bash -c "git add README.md"',
    'fish -c "git add README.md"',
    'git add "$(printf README.md)"',
    'git add "$' + '{ touch .git/hooks/pre-commit; }"',
    'git add "$' + '{| touch .git/hooks/pre-commit; }"',
    "git add README.md | tee result.txt",
  ])("leaves compound Git shell effects to the ordinary sandbox in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".git", "config"), "");

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "LOW",
    });
  });

  it("does not statically inspect Git metadata for an ordinary mutation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await writeFile(join(cwd, ".git"), "gitdir: /\n");

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("leaves Git metadata symlinks to the ordinary sandbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await symlink("/", join(cwd, ".git"));

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("leaves external Git metadata pointers to the ordinary sandbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const unrelated = await mkdtemp(join(tmpdir(), "pi-safety-unrelated-"));
    await writeFile(join(unrelated, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(unrelated, "config"), "");
    await mkdir(join(unrelated, "objects"));
    await mkdir(join(unrelated, "refs"));
    await symlink(unrelated, join(cwd, ".git"));

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("does not add metadata roots for an invalid linked-worktree pointer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const unrelated = await mkdtemp(join(tmpdir(), "pi-safety-unrelated-"));
    await writeFile(join(unrelated, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(unrelated, "config"), "");
    await mkdir(join(unrelated, "objects"));
    await mkdir(join(unrelated, "refs"));
    await writeFile(join(cwd, ".git"), `gitdir: ${unrelated}\n`);

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("does not add metadata roots for an invalid back-pointer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const unrelated = await mkdtemp(join(tmpdir(), "pi-safety-unrelated-"));
    await writeFile(join(cwd, ".git"), `gitdir: ${unrelated}\n`);
    await writeFile(join(unrelated, "gitdir"), `${join(cwd, ".git")}\n`);

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("does not grant per-worktree or common Git metadata roots", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const cwd = join(parent, "worktree");
    const commonGit = join(parent, "main.git");
    const worktreeGit = join(commonGit, "worktrees", "worktree");
    await mkdir(cwd);
    await mkdir(worktreeGit, { recursive: true });
    await writeFile(join(commonGit, "config"), "");
    await writeFile(join(commonGit, "HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(commonGit, "objects"));
    await mkdir(join(commonGit, "refs"));
    await writeFile(join(worktreeGit, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(worktreeGit, "commondir"), "../..\n");
    await writeFile(join(cwd, ".git"), `gitdir: ${worktreeGit}\n`);
    await writeFile(join(worktreeGit, "gitdir"), `${join(cwd, ".git")}\n`);
    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("does not grant a submodule Git metadata root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-submodule-"));
    const gitDirectory = await mkdtemp(join(tmpdir(), "pi-safety-module-git-"));
    await writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(gitDirectory, "config"), `[core]\n\tworktree = ${cwd}\n`);
    await mkdir(join(gitDirectory, "objects"));
    await mkdir(join(gitDirectory, "refs"));
    await writeFile(join(cwd, ".git"), `gitdir: ${gitDirectory}\n`);
    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("defers private shell network targets to the sandbox boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    const decision = await evaluateRiskRequest(
      "bash",
      { command: "curl http://127.0.0.1/admin" },
      cwd,
      config(),
    );

    expect(decision).toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("keeps private shell targets statically blocked when the sandbox is disabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const configured = config({
      sandbox: {
        ...structuredClone(DEFAULT_CONFIG.sandbox),
        enabled: false,
      },
    });

    await expect(
      evaluateRiskRequest("bash", { command: "curl http://127.0.0.1/admin" }, cwd, configured),
    ).resolves.toMatchObject({
      action: "block",
      risk: "HARD",
      reason: expect.stringContaining("Private"),
    });
  });

  it("blocks private WebFetch targets without offering reviewer approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    for (const url of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      await expect(evaluateRiskRequest("WebFetch", { url }, cwd, config())).resolves.toMatchObject({
        action: "block",
        risk: "HARD",
        reason: expect.stringContaining("Private"),
      });
    }
  });

  it("accepts Codex-style one-call write roots for agent bash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const outputName = `pi-safety-output-${Date.now()}`;
    const outputRoot = join("/var/tmp", outputName);
    const canonicalOutputRoot = join(await realpath("/var/tmp"), outputName);

    await expect(
      evaluateRiskRequest(
        "bash",
        {
          command: `mkdir -p ${outputRoot}`,
          sandbox_permissions: "with_additional_permissions",
          additional_permissions: {
            file_system: { write: [outputRoot, outputRoot] },
          },
          justification: "Write the requested build artifact",
        },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "REVIEW",
      filesystemWriteRoots: [canonicalOutputRoot],
    });
  });

  it("rejects malformed or protected agent bash permission requests", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    await expect(
      evaluateRiskRequest(
        "bash",
        {
          command: "mkdir -p /var/tmp/output",
          additional_permissions: {
            file_system: { write: ["/var/tmp/output"] },
          },
          justification: "missing sandbox permission mode",
        },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("sandbox_permissions"),
    });

    await expect(
      evaluateRiskRequest(
        "bash",
        {
          command: "touch /pi-safety-unsafe",
          sandbox_permissions: "with_additional_permissions",
          additional_permissions: {
            file_system: { write: ["/"] },
          },
          justification: "Request an unsafe broad root",
        },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("filesystem root"),
    });

    await expect(
      evaluateRiskRequest(
        "bash",
        {
          command: "printf x > .agents/AGENTS.md",
          sandbox_permissions: "with_additional_permissions",
          additional_permissions: {
            file_system: { write: [join(cwd, ".agents")] },
          },
          justification: "modify protected instructions",
        },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("protected"),
    });
  });

  it("routes require_escalated through an exact action review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-escalated-"));
    const decision = await evaluateRiskRequest(
      "bash",
      {
        command: "git add README.md && git commit -m update",
        sandbox_permissions: "require_escalated",
        justification: "Update the isolated fixture repository",
      },
      cwd,
      config(),
    );

    expect(decision).toMatchObject({
      action: "prompt",
      reason: "Command requires escalated sandbox permissions",
      executionMode: "escalated",
      justification: "Update the isolated fixture repository",
    });
    expect(decision).not.toHaveProperty("filesystemWriteRoots");
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("does not let an allow rule bypass an escalated action review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-escalated-"));
    const configured = config({
      rules: [{ action: "allow", tool: "bash", pattern: "git add *" }],
    });
    await expect(
      evaluateRiskRequest(
        "bash",
        {
          command: "git add README.md",
          sandbox_permissions: "require_escalated",
          justification: "Update the isolated fixture repository",
        },
        cwd,
        configured,
      ),
    ).resolves.toMatchObject({
      action: "prompt",
      executionMode: "escalated",
      reason: "Command requires escalated sandbox permissions",
    });
  });

  it("suppresses unsandboxed escalation when denyRead is configured (Codex parity)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-escalated-"));
    const configured = config({
      sandbox: {
        ...structuredClone(DEFAULT_CONFIG.sandbox),
        filesystem: {
          ...structuredClone(DEFAULT_CONFIG.sandbox.filesystem),
          denyRead: ["/secret"],
        },
      },
    });
    // denyRead only exists inside the sandbox, so require_escalated is
    // downgraded to the ordinary sandboxed path instead of HARD-blocked.
    await expect(
      evaluateRiskRequest(
        "bash",
        {
          command: "printf escalated",
          sandbox_permissions: "require_escalated",
          justification: "Run a controlled command",
        },
        cwd,
        configured,
      ),
    ).resolves.toMatchObject({
      action: "allow",
      risk: "LOW",
    });
  });

  it("lets an allow rule short-circuit a denyRead-suppressed escalation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-escalated-"));
    const configured = config({
      sandbox: {
        ...structuredClone(DEFAULT_CONFIG.sandbox),
        filesystem: {
          ...structuredClone(DEFAULT_CONFIG.sandbox.filesystem),
          denyRead: ["/secret"],
        },
      },
      rules: [{ action: "allow", tool: "bash", pattern: "printf *" }],
    });
    // Suppressed escalation is an ordinary sandboxed bash, so allow rules apply.
    // Unlike Codex (still one RequireEscalated approval), Pi does not force a prompt.
    await expect(
      evaluateRiskRequest(
        "bash",
        {
          command: "printf escalated",
          sandbox_permissions: "require_escalated",
          justification: "Run a controlled command",
        },
        cwd,
        configured,
      ),
    ).resolves.toMatchObject({
      action: "allow",
      risk: "LOW",
      reason: "Allowed by permissions rule",
    });
  });

  it("still prompts a dangerous command when denyRead suppresses escalation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-escalated-"));
    const configured = config({
      sandbox: {
        ...structuredClone(DEFAULT_CONFIG.sandbox),
        filesystem: {
          ...structuredClone(DEFAULT_CONFIG.sandbox.filesystem),
          denyRead: ["/secret"],
        },
      },
      rules: [{ action: "allow", tool: "bash", pattern: "printf *" }],
    });
    await expect(
      evaluateRiskRequest(
        "bash",
        {
          command: "rm -rf /tmp/does-not-matter",
          sandbox_permissions: "require_escalated",
          justification: "Delete a scratch tree",
        },
        cwd,
        configured,
      ),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "HARD",
      reason: "HARD operation",
    });
    const decision = await evaluateRiskRequest(
      "bash",
      {
        command: "rm -rf /tmp/does-not-matter",
        sandbox_permissions: "require_escalated",
        justification: "Delete a scratch tree",
      },
      cwd,
      configured,
    );
    expect(decision).not.toMatchObject({ executionMode: "escalated" });
  });

  it.each<Partial<SafetyConfig>>([
    {
      sandbox: {
        ...structuredClone(DEFAULT_CONFIG.sandbox),
        filesystem: {
          ...structuredClone(DEFAULT_CONFIG.sandbox.filesystem),
          denyWrite: ["/secret"],
        },
      },
    },
    {
      sandbox: {
        ...structuredClone(DEFAULT_CONFIG.sandbox),
        network: {
          ...structuredClone(DEFAULT_CONFIG.sandbox.network),
          deniedDomains: ["example.com"],
        },
      },
    },
  ])(
    "still issues an escalated lease when only denyWrite or deniedDomains are configured",
    async (override) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-escalated-"));
      const configured = config(override);
      await expect(
        evaluateRiskRequest(
          "bash",
          {
            command: "printf escalated",
            sandbox_permissions: "require_escalated",
            justification: "Run a controlled command",
          },
          cwd,
          configured,
        ),
      ).resolves.toMatchObject({
        action: "prompt",
        executionMode: "escalated",
        reason: "Command requires escalated sandbox permissions",
      });
    },
  );

  it("rejects escalation for non-Bash tools and malformed requests", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-escalated-"));
    await expect(
      evaluateRiskRequest(
        "write",
        { path: "out.txt", sandbox_permissions: "require_escalated", justification: "write" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "block", risk: "HARD" });
    await expect(
      evaluateRiskRequest(
        "bash",
        { command: "printf x", sandbox_permissions: "require_escalated" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "block",
      risk: "HARD",
      reason: expect.stringContaining("justification"),
    });
    await expect(
      evaluateRiskRequest(
        "bash",
        {
          command: "printf x",
          sandbox_permissions: "require_escalated",
          additional_permissions: { file_system: { write: ["/tmp"] } },
          justification: "conflicting modes",
        },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "block", risk: "HARD" });
  });

  it("applies deny, ask, and allow rules without bypassing hard policy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const rules: SafetyConfig["rules"] = [
      { action: "deny", tool: "bash", pattern: "npm publish*" },
      { action: "ask", tool: "bash", pattern: "npm test*" },
      { action: "allow", tool: "bash", pattern: "npm run lint*" },
      { action: "allow", tool: "bash", pattern: "curl *" },
    ];
    const configured = config({ rules });

    await expect(
      evaluateRiskRequest("bash", { command: "npm publish" }, cwd, configured),
    ).resolves.toMatchObject({ action: "block" });
    await expect(
      evaluateRiskRequest("bash", { command: "npm test" }, cwd, configured),
    ).resolves.toMatchObject({ action: "prompt" });
    await expect(
      evaluateRiskRequest("bash", { command: "npm run lint" }, cwd, configured),
    ).resolves.toMatchObject({ action: "allow" });
    await expect(
      evaluateRiskRequest("bash", { command: "curl http://127.0.0.1/admin" }, cwd, configured),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("keeps private targets out of sandboxed Bash pre-admission capability requests", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const configured = config({ rules: [{ action: "ask", tool: "bash", pattern: "curl *" }] });

    const decision = await evaluateRiskRequest(
      "bash",
      { command: "curl http://127.0.0.1/admin" },
      cwd,
      configured,
    );

    expect(decision).toMatchObject({ action: "prompt", risk: "LOW" });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("summarizes requests without including write content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const decision = await evaluateRiskRequest(
      "write",
      { path: "/var/tmp/out.txt", content: "DO_NOT_RENDER_THIS_SECRET" },
      cwd,
      config(),
    );

    expect(decision.action).toBe("prompt");
    if (decision.action === "prompt") {
      expect(decision.summary).toContain("/var/tmp/out.txt");
      expect(decision.summary).not.toContain("DO_NOT_RENDER_THIS_SECRET");
    }
  });
});

describe("deletion sandbox boundary (stage 3)", () => {
  it("auto-approves deletions inside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-del-"));
    await writeFile(join(cwd, "build", "a.ts"), "x").catch(() => {});
    for (const command of [
      "rm build/a.ts",
      "rm -r build",
      "rmdir cache",
      "unlink build/a.ts",
      "shred build/a.ts",
      "truncate -s 0 build/a.ts",
    ]) {
      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    }
  });

  it("defers outside-root deletion to the exact runtime sandbox denial", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-del-"));
    for (const command of [
      "rm /etc/pi-safety-outside.txt",
      "rm /etc/passwd",
      "rm ~/.aws/credentials",
      "truncate -s 0 /etc/passwd",
    ]) {
      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    }
  });

  it("escalates protected metadata deletion but not ordinary workspace files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-del-"));
    await expect(
      evaluateRiskRequest("bash", { command: "rm .git/HEAD" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    await expect(
      evaluateRiskRequest("bash", { command: "rm .env" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("reviews forced rm even when its target stays inside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-del-"));
    await expect(
      evaluateRiskRequest("bash", { command: "rm -rf build" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "HARD" });
  });
});

describe("request_permissions amendment decisions", () => {
  it("prompts with normalized public hosts and write roots", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-rp-eval-"));
    await expect(
      evaluateRiskRequest(
        "request_permissions",
        {
          permissions: { network: { hosts: ["api.example.com"] } },
          scope: "turn",
        },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "REVIEW",
      networkHosts: ["api.example.com"],
    });
  });

  it("blocks private hosts and empty amendments without treating them as custom tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-rp-eval-"));
    await expect(
      evaluateRiskRequest(
        "request_permissions",
        { permissions: { network: { hosts: ["127.0.0.1"] } } },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "block", risk: "HARD" });
    await expect(
      evaluateRiskRequest("request_permissions", { permissions: {} }, cwd, config()),
    ).resolves.toMatchObject({ action: "block", risk: "HARD" });
  });

  it("does not honor an allow-rule bypass for request_permissions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-rp-eval-"));
    const allowed = config({
      rules: [{ action: "allow", tool: "request_permissions" }],
    });
    await expect(
      evaluateRiskRequest(
        "request_permissions",
        { permissions: { network: { hosts: ["api.example.com"] } } },
        cwd,
        allowed,
      ),
    ).resolves.toMatchObject({ action: "prompt", networkHosts: ["api.example.com"] });
  });
});

describe("custom/MCP tool approvals (codex-aligned)", () => {
  it("allows external tools by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-mcp-"));
    for (const [tool, input] of [
      ["gitee__create_issue", { title: "x" }],
      ["mcp__github__get_issue", { owner: "a", repo: "b", number: 1 }],
      ["my_custom_tool", { query: "hello" }],
    ] as const) {
      await expect(evaluateRiskRequest(tool, input, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "LOW",
      });
    }
  });

  it("uses exact-name and glob rules to opt external tools into review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-mcp-"));
    const exact = config({ rules: [{ action: "ask", tool: "gitee__create_issue" }] });
    await expect(
      evaluateRiskRequest("gitee__create_issue", { title: "x" }, cwd, exact),
    ).resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    await expect(
      evaluateRiskRequest("gitee__create_pr", { title: "y" }, cwd, exact),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });

    const globbed = config({ rules: [{ action: "ask", tool: "mcp__*" }] });
    await expect(
      evaluateRiskRequest("mcp__github__get_issue", { owner: "a" }, cwd, globbed),
    ).resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    await expect(
      evaluateRiskRequest("gitee__create_issue", { title: "x" }, cwd, globbed),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("keeps exact-name rules for built-in tools intact", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-mcp-"));
    const configured = config({ rules: [{ action: "deny", tool: "bash", pattern: "rm *" }] });
    await expect(
      evaluateRiskRequest("bash", { command: "rm build/a.ts" }, cwd, configured),
    ).resolves.toMatchObject({ action: "block" });
    await expect(
      evaluateRiskRequest("read", { path: "README.md" }, cwd, configured),
    ).resolves.toMatchObject({ action: "allow" });
  });
});

describe("RiskDecision residual stamps", () => {
  it("stamps rule_ask on owned rule.ask prompts; host-first B has no prompt residuals", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-residual-host-"));
    const hostConfig = config({
      rules: [{ action: "ask", tool: "WebFetch", pattern: "*example.com*" }],
    });
    expect(
      evaluateHostFirstRulesOnly("WebFetch", { url: "https://example.com/docs" }, cwd, hostConfig),
    ).toBeUndefined();
    await expect(
      evaluateHostRiskRequest("WebFetch", { url: "https://example.com/docs" }, cwd, hostConfig),
    ).resolves.toMatchObject({ action: "allow" });

    const bashConfig = config({
      rules: [{ action: "ask", tool: "bash", pattern: "npm test*" }],
    });
    const owned = await evaluateRiskRequest("bash", { command: "npm test" }, cwd, bashConfig);
    expect(owned).toMatchObject({
      action: "prompt",
      residuals: expect.arrayContaining(["rule_ask"]),
    });
  });

  it("stamps escalation on require_escalated prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-residual-esc-"));
    const decision = await evaluateRiskRequest(
      "bash",
      {
        command: "git add README.md && git commit -m update",
        sandbox_permissions: "require_escalated",
        justification: "Update the isolated fixture repository",
      },
      cwd,
      config(),
    );
    expect(decision).toMatchObject({
      action: "prompt",
      residuals: expect.arrayContaining(["escalation"]),
    });
  });

  it("stamps permission_amendment on request_permissions prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-residual-amend-"));
    const decision = await evaluateRiskRequest(
      "request_permissions",
      { permissions: { filesystem: { write: [join(cwd, "out")] } }, scope: "turn" },
      cwd,
      config(),
    );
    expect(decision).toMatchObject({
      action: "prompt",
      residuals: expect.arrayContaining(["permission_amendment", "write_root_uncovered"]),
    });
  });

  it("keeps sandboxed non-dangerous bash allow/LOW without residuals", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-residual-allow-"));
    const decision = await evaluateRiskRequest("bash", { command: "npm test" }, cwd, config());
    expect(decision).toMatchObject({ action: "allow", risk: "LOW" });
    expect(decision).not.toHaveProperty("residuals");
  });

  it("keeps the rule.allow short-circuit allow without residuals", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-residual-allow-rule-"));
    const configured = config({
      rules: [{ action: "allow", tool: "bash", pattern: "curl *" }],
    });
    const decision = await evaluateRiskRequest(
      "bash",
      { command: "curl -X POST https://example.com/api" },
      cwd,
      configured,
    );
    expect(decision).toMatchObject({
      action: "allow",
      risk: "LOW",
      reason: "Allowed by permissions rule",
    });
    expect(decision).not.toHaveProperty("residuals");
  });

  it("stamps risk_not_low on dangerous/HARD prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-residual-hard-"));
    const decision = await evaluateRiskRequest("bash", { command: "rm -rf build" }, cwd, config());
    expect(decision).toMatchObject({
      action: "prompt",
      risk: "HARD",
      residuals: expect.arrayContaining(["risk_not_low"]),
    });
  });
});
