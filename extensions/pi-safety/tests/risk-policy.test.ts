import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SafetyConfig } from "../src/config.ts";
import { packageRoot } from "../src/filesystem-policy.ts";
import { admissionPlanFromRiskDecision } from "../src/pi-guardian-adapters.ts";
import {
  evaluateDenyRulesOnly,
  evaluateHostRiskRequest,
  evaluateRiskRequest,
  isSupportedPermissionRequestShape,
} from "../src/risk-policy.ts";
import { isPermissionArgumentError } from "../src/shell-permissions.ts";
import { createGitDirectory } from "./git-fixtures.ts";

function config(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
  };
}

describe("Permission request own-property shape", () => {
  function request() {
    return {
      scope: "turn",
      reason: "bounded access",
      permissions: {
        network: { hosts: ["narrow.example"] },
        file_system: { write: ["/tmp/request-shape"] },
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
  describe.each(["root", "permissions", "network", "file_system", "hosts", "write"] as const)(
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
                  : layer === "file_system"
                    ? [input.permissions.file_system, "write", input.permissions.file_system.write]
                    : layer === "hosts"
                      ? [input.permissions.network.hosts, "0", "narrow.example"]
                      : [input.permissions.file_system.write, "0", "/tmp/request-shape"];
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
      permissions:
        key === "hosts" ? { network: { hosts: list } } : { file_system: { write: list } },
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
        input.permissions.file_system,
      ];
      const lists = [input.permissions.network.hosts, input.permissions.file_system.write];
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

  it("rejects the legacy filesystem spelling so no compatibility alias returns", () => {
    expect(
      isSupportedPermissionRequestShape({
        scope: "turn",
        permissions: { filesystem: { write: ["/tmp/legacy"] } },
      }),
    ).toBe(false);
  });
});

describe("ApprovalDisposition policy gate", () => {
  it("orders deny above allow and falls through to review, never to allow", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-gate-"));

    // Ordering is observable only where two gates can both fire *and* still
    // reach `decide()`: a deny rule exits earlier, and `matchRules` already
    // collapses a deny and an allow into one decision. A protected path and a
    // proven-safe argv are the pair that qualifies — both would otherwise
    // decide this call, so the deny gate listed first must win.
    // `.agents` is a default protected write path, so the protected-path gate
    // fires while the argv itself is a plain, provable-safe write.
    await expect(
      evaluateRiskRequest(
        "write",
        { path: join(cwd, ".agents/note.md"), content: "x" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("protected"),
      recoverable: "no",
    });

    // The same call without the guard is a proven-safe write, so this pair is
    // exactly what swapping the two gate closures in `decide()` would flip.
    await expect(
      evaluateRiskRequest("write", { path: join(cwd, "plain/file"), content: "x" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });

    // An allow rule cannot force execution of a command the classifier could
    // not prove safe: the allow gate requires `risk !== "Forbidden"`.
    const allowAll = config({ rules: [{ action: "allow", tool: "WebFetch", pattern: "*" }] });
    await expect(
      evaluateRiskRequest("WebFetch", { url: "http://127.0.0.1/admin" }, cwd, allowAll),
    ).resolves.toMatchObject({ action: "prompt" });

    // An ask rule outranks the proof gate: a provably safe argv still becomes
    // an action review, because the user asked for one.
    const askSafe = config({ rules: [{ action: "ask", tool: "bash", pattern: "printf *" }] });
    const asked = await evaluateRiskRequest("bash", { command: "printf hi" }, cwd, askSafe);
    expect(asked).toMatchObject({
      action: "prompt",
      risk: "Skip",
      reason: "Approval required by permissions rule",
    });
    expect(admissionPlanFromRiskDecision(asked)).toMatchObject({
      kind: "review",
      review: "action",
    });
  });

  it("keeps a deny rule above the external-tool compatibility branch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-gate-"));

    // An unrecognized tool name normalizes to operation "external", which has
    // its own allow/prompt branch. A deny rule must still win: the branch is a
    // compatibility path for tools that never reach classification, not a way
    // past the user's own refusal.
    const denied = config({ rules: [{ action: "deny", tool: "mcp__custom", pattern: "*" }] });
    await expect(
      evaluateRiskRequest("mcp__custom", { anything: "x" }, cwd, denied),
    ).resolves.toMatchObject({
      action: "block",
      risk: "Forbidden",
      reason: "Denied by permissions rule",
      recoverable: "no",
    });

    // Without a deny rule the same call keeps the compatibility behaviour.
    await expect(
      evaluateRiskRequest("mcp__custom", { anything: "x" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", reason: "Host tool policy" });

    // An ask rule on the same branch still prompts.
    const asked = config({ rules: [{ action: "ask", tool: "mcp__custom", pattern: "*" }] });
    await expect(
      evaluateRiskRequest("mcp__custom", { anything: "x" }, cwd, asked),
    ).resolves.toMatchObject({
      action: "prompt",
      reason: "Approval required by permissions rule",
    });
  });

  it("treats an unproven argv as review and an approved write root as a grant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-gate-"));
    // /var/tmp is outside the default allowWrite roots ($TMPDIR resolves to
    // /private/tmp, which the default config already allows), so this root is
    // genuinely a grant rather than a no-op.
    const outputRoot = join(await realpath("/var/tmp"), `pi-safety-grant-${Date.now()}`);

    // The classifier cannot prove this safe (`sudo` is a proven dangerous
    // form), so no allow gate fires and the fall-through exit is review. It
    // must not read as allow.
    const dangerous = await evaluateRiskRequest(
      "bash",
      { command: "sudo rm -rf /var/tmp/pi-safety-gate" },
      cwd,
      config(),
    );
    expect(dangerous).toMatchObject({ action: "prompt", risk: "NeedsApproval" });

    // An additional write root is a grant, not a proof. It must keep the
    // packet at NeedsApproval so a reviewer reads the widened scope, and it
    // must not be discharged by a matching allow rule.
    const granted = await evaluateRiskRequest(
      "bash",
      {
        command: `mkdir -p ${outputRoot}`,
        sandbox_permissions: "with_additional_permissions",
        additional_permissions: { file_system: { write: [outputRoot] } },
        justification: "Write the requested build artifact",
      },
      cwd,
      config(),
    );
    expect(granted).toMatchObject({ action: "prompt", risk: "NeedsApproval" });

    const allowAll = config({ rules: [{ action: "allow", tool: "bash", pattern: "*" }] });
    const stillReviewed = await evaluateRiskRequest(
      "bash",
      {
        command: `mkdir -p ${outputRoot}`,
        sandbox_permissions: "with_additional_permissions",
        additional_permissions: { file_system: { write: [outputRoot] } },
        justification: "Write the requested build artifact",
      },
      cwd,
      allowAll,
    );
    expect(stillReviewed).toMatchObject({ action: "prompt", risk: "NeedsApproval" });
  });

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
        risk: "Skip",
      });
      expect(evaluateDenyRulesOnly(tool, input, cwd, config())).toBeUndefined();
    }

    const askOnly = config({
      rules: [{ action: "ask", tool: "WebFetch", pattern: "*example.com*" }],
    });
    expect(
      evaluateDenyRulesOnly("WebFetch", { url: "https://example.com/docs" }, cwd, askOnly),
    ).toBeUndefined();
    await expect(
      evaluateHostRiskRequest("WebFetch", { url: "https://example.com/docs" }, cwd, askOnly),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });

    const denyRules = config({
      rules: [{ action: "deny", tool: "read", pattern: "*/Library/*" }],
    });
    expect(
      evaluateDenyRulesOnly(
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
    ).resolves.toMatchObject({ action: "block", risk: "Forbidden" });
  });

  it("allows ordinary workspace reads and writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    await expect(
      evaluateRiskRequest("read", { path: "README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
    await expect(
      evaluateRiskRequest("write", { path: "notes.txt", content: "hello" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
    await expect(
      evaluateRiskRequest("write", { path: ".pi/permissions.json", content: "{}" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  it("allows routine host tools, including MCP-style direct tool names", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    for (const tool of ["context7_resolve-library-id", "exa_web_search_exa", "tinyfish_search"]) {
      await expect(
        evaluateRiskRequest(tool, { query: "public docs" }, cwd, config()),
      ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
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
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  it("does not add sensitive-file restrictions beyond Codex workspace-write", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    for (const path of [".env", "nested/.env", "nested/.env.local", "nested/deploy.key"]) {
      await expect(evaluateRiskRequest("read", { path }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
      await expect(
        evaluateRiskRequest("write", { path, content: "secret" }, cwd, config()),
      ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
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
        risk: "Skip",
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
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
    await expect(
      evaluateRiskRequest("write", { path: "notes.txt", content: "x" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
    await expect(
      evaluateRiskRequest(
        "write",
        { path: resolve("/tmp", "pi-home-ok.txt"), content: "x" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
    await expect(
      evaluateRiskRequest(
        "request_permissions",
        { permissions: { file_system: { write: [cwd] } }, scope: "turn" },
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

    // Cut 3: outside-roots writes run and the sandboxed file operations
    // deny them at runtime (recovery review on exact denial).
    await expect(
      evaluateRiskRequest("write", { path: "/var/tmp/out.txt", content: "x" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
    await expect(
      evaluateRiskRequest("bash", { command: "rm -rf build" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "NeedsApproval" });
  });

  it("reviews a forced rm hidden behind control-flow keywords (Codex parity)", async () => {
    // The char segmenter leaves do/then/{ as the segment executable; stripping
    // those syntax keywords surfaces the real argv so a forced rm is still
    // caught (matches codex's AST descent into control-flow clauses).
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    for (const command of [
      'for target in /tmp/a /tmp/b; do rm -r -f "$target"; done',
      "if test -d /tmp/example; then rm --force /tmp/example; fi",
      "{ rm -f /tmp/example; }",
      "for i in a; do trap 'rm -rf /tmp/example' EXIT; done",
      "{ trap 'rm -rf /tmp/example' EXIT; }",
      "do FOO=1 rm -f /tmp/example",
      "if true; then BAR=1 rm --force /tmp/example; fi",
      "for i in a; do FOO=1 trap 'rm -f /tmp/example' EXIT; done",
    ]) {
      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "prompt",
        risk: "NeedsApproval",
      });
    }
  });

  it("leaves protected bash deletions to the runtime sandbox", async () => {
    // Cut 3 deleted the deletion carve-out: `rm .git/HEAD` runs and SRT
    // denies it via the protected write roots (audit: sandboxed
    // enforcement). Forced rm still reviews via Tier 1.
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    for (const command of [
      "for i in a; do rm .git/HEAD; done",
      "{ rm .git/HEAD; }",
      "time rm .git/HEAD",
    ]) {
      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    }
  });

  it("keeps literal and sequenced non-dangerous commands auto-run", async () => {
    // Reserved-word stripping must not over-match: single-quoted text and plain
    // sequencing hide no forced rm and stay allow/LOW.
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    for (const command of [
      "echo 'rm -rf /tmp/x'",
      "cat a; pwd",
      "env FOO=1 npm test",
      "FOO=1 echo hi",
      "do FOO=1 echo hi",
      // Bash treats a reserved word behind an assignment as an ordinary command
      // name (`do: command not found`), so it is not structural and must not be
      // reduced into a forced rm.
      "FOO=1 do rm -f /tmp/x",
      "env FOO=1 do rm -f /tmp/x",
    ]) {
      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    }
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
        risk: "Skip",
      });
    }
  });

  // Cut 3: only executable-hiding shapes stay review. A hidden program
  // string (`eval`, `python -c`, `sh` stdin, `find -exec`, `xargs`) runs
  // sandboxed like codex — the sandbox, not a guessing reviewer, owns
  // what it cannot see. What stays: a hidden executable WORD (the shell
  // decides the program at runtime) and dangerous bodies Tier 1 screens.
  // Each deleted row below was verified Skip with a live or codex-parity
  // reason; the sandbox + runtime boundary is the backstop.
  it.each([
    "$(echo rm) -rf /",
    'bash -c "$CMD -rf /"',
    // The variable executable arrives on its own segment, so letting it
    // Skip would let `$cmd` decide at runtime whether `rm` runs with `-rf`
    // (measured live: the victim deletes).
    "cmd=rm; $cmd -rf /tmp/x",
  ])("reviews hidden-executable-word Bash command %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-unclassifiable-"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "prompt",
      risk: "NeedsApproval",
    });
  });

  // A parse that yields no plain commands falls back to the raw command
  // vector, which codex judges by its first word (`is_dangerous_command`
  // in `exec_policy.rs`). A non-dangerous first word is allowed, so the
  // codex-aligned tier-4a fallback (`risk.ts`) Skips it: an incomplete
  // heredoc (`cat <<`), a pure assignment with no command (`FOO=1`),
  // and a redirect with no command (`>out`) all auto-run. The fallback
  // covers commands whose segments are *all* `lex_incomplete` — no
  // token-level expansion anywhere, which is what handing the whole raw
  // vector over means (exec_policy.rs:900-902). One segment carrying a
  // stronger unproven reason (a variable executable, a substitution, a
  // heredoc) is not that case and stays a review. A dangerous first word
  // is still caught: `rm -rf / <<` keeps the forced rm at review.
  it.each(["cat <<", "FOO=1", ">out"])(
    "auto-runs a parse-failure command with a non-dangerous first word in %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-parse-failure-"));

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    },
  );

  it("reviews a parse-failure command whose first word is a forced rm", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-parse-failure-"));

    await expect(
      evaluateRiskRequest("bash", { command: "rm -rf / <<" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "NeedsApproval" });
  });

  // Parameter expansion decides the argv at runtime, and the substituted word is
  // where a flag lives. The executable being known does not make the words known:
  // `git commit "${FLAG:--S}" -m x` names git perfectly and chooses between a
  // plain commit and a GPG-signing one without naming either. fx sends any `$`
  // outside single quotes to review for the same reason
  // (`command_effect.zig:386`); an expanded word is whatever the variable holds,
  // so Tier 3's assertion that nothing is left to prove does not hold.
  //
  // These need a repository: `git fetch` is a network subcommand, so without one
  // the implicit-remote rule refuses it first and the substitution never gets
  // tested. That is a different rule producing a stricter verdict, not a
  // contradiction.
  it.each([
    'git commit "${FLAG:--S}" -m update',
    'git diff "${OPT:---ext-diff}"',
    'git fetch "$REMOTE"',
  ])("runs a Git invocation with an expanded argument sandboxed in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-unclassifiable-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
    });
  });

  // A dynamic *argument* is not a dynamic command: the executable is still the
  // one we read, so plain words and redirects stay LOW.
  //
  // The single-quoted forms are the control, and they stay: `'$(pwd)'` and
  // `'{ print $1 }'` cannot expand at all, so a `$` inside single quotes is
  // literal and the argv is still fixed.
  it.each([
    "echo hello",
    "ls > out.log",
    "cat README.md > copy.txt",
    "cat README.md | wc -l",
    "cat '$(pwd)'",
    // The positive control for the rule above: a `$` inside single quotes is
    // literal, so the argv is fixed and the command stays auto-approvable. The
    // same character unquoted (`ls $DIR`) is in the review table.
    "git commit -m 'costs $5'",
    "bash script.sh",
    "bash -x script.sh",
    "python script.py",
    "php script.php",
    "deno run script.ts",
    "node --version",
    // An option's value is skipped, not swallowed: the operand behind it is
    // still found, so the segment stays a fixed argv.
    "bash -o pipefail script.sh",
    "python -W ignore script.py",
    "php -d memory_limit=1G script.php",
    "perl -I lib script.pl",
    "deno run -A script.ts",
    "npm test && pnpm lint",
    "echo 'a { b }'",
    "awk '{ print $1 }'",
  ])("keeps decomposable Bash command %s auto-run", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-unclassifiable-"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
    });
  });

  it("keeps a proven-dangerous segment at review inside an unclassifiable command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-unclassifiable-"));

    await expect(
      evaluateRiskRequest("bash", { command: 'rm -rf /tmp/x; echo "$(pwd)"' }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "NeedsApproval" });
  });

  // A trap action that is itself a proven-dangerous command stays a review
  // (NeedsApproval): the dangerous tier is checked before the unclassifiable
  // one, so the extra review never *downgrades* a proven rm.
  it("keeps a proven-dangerous trap action at review, not SKIP", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-unclassifiable-"));

    await expect(
      evaluateRiskRequest("bash", { command: "trap 'rm -rf /' EXIT" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "NeedsApproval" });
  });

  // External side effects are not exempted by the sandbox's network approval:
  // Remote API semantics are the reviewer's judgement, and the boundary that is
  // actually enforced is the network lease. A search for these tools in the
  // pinned Codex shell-command crate returns zero files, and its only
  // dangerous-command rules are forced `rm` and an exceeded wrapper-depth bound;
  // fx matches. This used to assert HARD from a verb denylist, which could not
  // support the claim: `gh pr edit` and `gh api -X POST` auto-approved while
  // `gh pr merge` was blocked, so the table read as coverage without being any.
  //
  // The cases below are the ones that table used to block. They are LOW now, and
  // the guarantee is unchanged in the only place that matters: the sandbox
  // refuses the connection. An invocation that needs the network without an
  // approved lease is still HARD before this classifier is consulted, and the
  // per-connection authorizer checks the real host when one is attempted.
  it.each([
    "terraform apply -auto-approve",
    "tofu destroy -auto-approve",
    "terraform --chdir /tmp apply -auto-approve",
    "kubectl delete deployment production",
    "kubectl exec pod -- rm -rf /tmp/x",
    "gh pr merge 12",
    "gh pr create --title --help --body x",
    "aws s3 rm s3://bucket/key",
    "aws ec2 terminate-instances --instance-ids i-1",
    "gcloud compute instances delete vm",
    "gcloud compute instance-groups managed delete group",
    "az vm delete --name vm",
    "helm uninstall release",
    "npm publish",
    "cargo yank crate",
    "vercel --prod",
  ])(
    "leaves remote API semantics to the reviewer and the network boundary: %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-unclassifiable-"));

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    },
  );
  it.each([
    "aws s3 ls s3://bucket",
    "gcloud compute instances list",
    "kubectl get pods",
    "helm list",
    "gh run list",
    "gh pr list",
    "npm ls",
    // The verb is the first operand, so an option *after* it must not be read
    // as one: here `apply` is the plan file's name, and the subcommand is the
    // read-only `plan`.
    "terraform plan -out apply",
    "terraform plan -out=tf.plan",
    "gh pr list --state open",
    // A verb deeper than the old three-position window, and an option list
    // whose grammar cannot be read — the second is a review, not a LOW.
    "gcloud compute instance-groups managed list group",
    "helm list -A",
    "kubectl get pods --all-namespaces",
    // A terminal flag after the verb is still a flag, not a mutation — the
    // short-circuit that used to fire here also fired on `gh pr create
    // --title --help`, where `--help` is the title.
    "gh pr list --help",
  ])("keeps a read-only control-plane query out of the mutation table: %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-unclassifiable-"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
    });
  });

  it("defers ordinary Bash network decisions to the runtime sandbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const cases = [
      [
        "gh issue comment 1 --body https://example.com",
        ["api.github.com", "github.com", "uploads.github.com"],
      ],
      ["gh pr edit 1 --title x", ["api.github.com", "github.com", "uploads.github.com"]],
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
        risk: "Skip",
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
      risk: "Skip",
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
    expect(decision).toMatchObject({ action: "allow", risk: "Skip" });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("refuses broken Git metadata as deterministic, never as retryable", async () => {
    // A dangling `gitdir:` pointer makes discovery fail after the implicit
    // remote is established, which is the only path that inspects repository
    // metadata. That failure is a fact about the working copy, so the agent
    // must not be told a retry could succeed.
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await writeFile(join(cwd, ".git"), "gitdir: /nonexistent/pi-safety-target\n");

    await expect(
      evaluateRiskRequest("bash", { command: "git push origin main" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "block",
      risk: "Forbidden",
      reason: expect.stringContaining("unsafe Git metadata"),
      recoverable: "no",
    });
  });

  it("keeps a mandatory rule review mandatory for an implicit Git push", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      '[remote "origin"]\n\turl = https://covered.example/owner/repo.git\n',
    );
    const next = config();
    next.sandbox.network.allowedDomains = ["covered.example"];
    next.rules = [{ action: "ask", tool: "bash", pattern: "git push*" }];

    // The destination is already covered by the baseline lease, so it is not a
    // capability that needs reviewing. The rule still does. The admission has
    // to stay an `action` review, because `forcedManualReview` keys off that
    // shape: turning it into a `capability` review would let the Engine filter
    // the covered host out and skip the review the rule demanded.
    const decision = await evaluateRiskRequest(
      "bash",
      { command: "git push origin main" },
      cwd,
      next,
    );

    expect(decision).toMatchObject({
      action: "prompt",
      reason: "Approval required by permissions rule",
    });
    expect(admissionPlanFromRiskDecision(decision)).toMatchObject({
      kind: "review",
      review: "action",
    });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("leaves a sandboxed implicit Git push on the connection boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      '[remote "origin"]\n\turl = https://sandboxed.example/owner/repo.git\n',
    );

    // Sandboxed actions are enforced per connection, so the destination does not
    // need to become a reviewed capability and the allow decision is unchanged.
    const decision = await evaluateRiskRequest(
      "bash",
      { command: "git push origin main" },
      cwd,
      config(),
    );
    expect(decision).toMatchObject({ action: "allow", risk: "Skip" });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("does not invent a capability for a Git remote named in the command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      '[remote "origin"]\n\turl = https://named.example/owner/repo.git\n',
    );

    // An explicit remote is already stated by the frozen command, so it is
    // bound by the call fingerprint and needs no separate capability.
    const decision = await evaluateRiskRequest(
      "bash",
      { command: "git push https://named.example/owner/repo.git main" },
      cwd,
      config(),
    );
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
      risk: "Skip",
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
        risk: "Skip",
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
        risk: "Skip",
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
      risk: "Skip",
    });
  });

  it("keeps unsupported Git remote helpers statically blocked", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateRiskRequest("bash", { command: "git fetch ext::/tmp/network-helper" }, cwd, config()),
    ).resolves.toMatchObject({ action: "block", risk: "Forbidden" });
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
      expect(decision).toMatchObject({ action: "allow", risk: "Skip" });
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
    expect(decision).toMatchObject({ action: "allow", risk: "Skip" });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("keeps a local Git remote operand out of network policy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));
    await expect(
      evaluateRiskRequest("bash", { command: "git push ../local.git HEAD:main" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
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
      risk: "Forbidden",
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
    expect(decision).toMatchObject({ action: "allow", risk: "Skip" });
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
    expect(decision).toMatchObject({ action: "allow", risk: "Skip" });
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
      risk: "Skip",
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
      risk: "Skip",
    });
    const ghDecision = await evaluateRiskRequest(
      "bash",
      { command: "gh pr checkout 123" },
      cwd,
      config(),
    );
    expect(ghDecision).toMatchObject({ action: "allow", risk: "Skip" });
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
        risk: "Skip",
      });
    }
  });

  // These were previously one table asserting `Skip` for all six, which merged
  // two unrelated threat classes. A config key that installs a program
  // (`core.hooksPath` names a directory of hook executables, not a setting) is
  // code execution; a relocation (`-C`, `--git-dir`) is visible in the argv and
  // executable only in the repository it selects. Bundling them protected the
  // first class along with the second, and the allowlist entry for
  // `core.hooksPath` also outlived the filesystem defence it cited: the sandbox
  // policy hard-denies `<gitdir>/hooks` for the roots `git-metadata.ts`
  // discovers, but `hooksPath` moves the search outside `$GIT_DIR/hooks`, so
  // `/tmp/hooks` was covered by neither layer.
  //
  // An unrecognised global option sits in the second class for the same reason:
  // it does not install anything, and git rejects it outright.
  it.each([
    // Installs a program the same invocation then runs: still review
    // (cut-3 promotion — proven nested-program execution, not unproven
    // surroundings). Codex has no Git arm; this review is ours.
    "git -c core.hooksPath=/tmp/hooks commit -am update",
    "git --config-env=core.hooksPath=HOOKS commit -am update",
    "git -c alias.probe=!touch /tmp/p commit -am update",
  ])("reviews a Git global option that installs a program in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "prompt",
      risk: "NeedsApproval",
    });
  });

  // Cut 3: relocation-only and unknown-grammar options run sandboxed —
  // the sandbox owns the cwd and the command fails safe (git rejects
  // unknown globals outright).
  it.each([
    "git -C child commit -am update",
    "git --git-dir ../repo.git commit -am update",
    "git --work-tree ../tree commit -am update",
    "git --unknown-global commit -am update",
  ])("runs a relocating Git global option sandboxed in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
    });
  });

  // The counter-test for the same judgment: a provable setting stays provable.
  // Without this the `-c` handling could be made strict by refusing everything,
  // which would pass the table above for the wrong reason. `core.editor` is
  // deliberately absent — it names a program Git launches for an interactive
  // commit, so it belongs in the table above, not here.
  it.each([
    "git -c user.name=Ada commit -am update",
    "git -c core.autocrlf=input commit -am update",
    "git -c core.abbrev=12 commit -am update",
  ])("still auto-approves a provable scalar config key in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
    });
  });

  it.each([
    // `env -C DIR` moves the working directory the wrapped command runs in, so
    // `README.md` is resolved against a root this request never named and the
    // write-root check runs against the wrong tree. The reference implementation
    // does not parse `--chdir` either; it sends the whole `env` invocation to
    // review. This is that case, and it is the one wrapper option in this table
    // that is not a plain assignment or an identity test.
    //
    // It is refused rather than reviewed, which is a change from the original
    // intent recorded here. `env` stays anchored when its option grammar cannot
    // be reduced, so the words after `-C` do not provably begin with the
    // delegated command and the program behind `env` is unidentified — the same
    // verdict as any other unidentifiable program. The original "send the whole
    // `env` invocation to review" was written before program identity was
    // separated from the surroundings it runs in; that separation is what makes
    // a review and a refusal different questions here.
    "env -C /tmp git add README.md",
    "env --chdir=/tmp git add README.md",
  ])("refuses to auto-approve a working-directory change in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "block",
      risk: "Forbidden",
    });
  });

  // This was one table asserting `Skip` for all seven, which asserted the
  // fail-open directly: `executableTrusted` was computed and then read only
  // inside `parsedGitRemotes`, behind its `gitInvocationUsesNetwork` early
  // return, so it could only ever affect a subcommand already classified as
  // reaching a remote. `PATH=/tmp git status` was therefore indistinguishable
  // from `git status`. The tables below hold the `git commit` / `git add`
  // spellings that still auto-approve, so each refusal is attributable to
  // program identity rather than to the subcommand.
  it.each([
    "./git commit -am update",
    "/tmp/git commit -am update",
    "PATH=/tmp git commit -am update",
    "env PATH=/tmp git commit -am update",
  ])(
    "refuses to auto-approve a Git mutation whose program cannot be identified in %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
      await createGitDirectory(join(cwd, ".git"));

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "block",
        risk: "Forbidden",
      });
    },
  );

  // `GIT_DIR` / `GIT_WORK_TREE` relocate the repository rather than naming a
  // program, so they are separated from the table above. The relocated
  // repository's own `<gitdir>/hooks` does fall outside the roots
  // `git-metadata.ts` discovers from cwd, so the filesystem hard-deny does not
  // cover it — but the words still name Git, and a human reading the command can
  // see the relocation. An earlier version refused these, which put an inert
  // `GIT_` variable in the same class as `PATH=/tmp git commit` and cost the
  // ordinary `GIT_AUTHOR_NAME=… git commit` its review.
  it.each([
    "GIT_DIR=/tmp/repo.git git add README.md",
    "env GIT_WORK_TREE=/tmp/tree git add README.md",
  ])("runs a Git mutation that only relocates the repository sandboxed in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
    });
  });

  // The counter-test for the split, and the boundary it draws. `identity`
  // decides refusal, `context` decides review — and since cut 3 neither an
  // inert `GIT_*` environment nor an unproven global option reaches review
  // on its own. What the environment can change about which program runs
  // is still caught by the fold (`nested_git_program`, promoted to a
  // static review) and by Tier 1.
  it.each([
    ["git status", "allow", "Skip"],
    ["GIT_TRACE=1 git status", "allow", "Skip"],
    ["GIT_OPTIONAL_LOCKS=0 git status", "allow", "Skip"],
    ["GIT_AUTHOR_NAME=Ada git commit -am update", "allow", "Skip"],
  ])("keeps %s at the tier its environment impact earns", async (command, action, risk) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action,
      risk,
    });
  });

  // A `cd` between segments relocates everything after it. `git push` then runs
  // in a repository whose config, `core.hooksPath` and implicit remote are not
  // the ones this inspection read — the implicit-remote lookup uses the `cwd` the
  // request arrived with. `git -C DIR` is already refused on the same reasoning;
  // an ordinary `cd` was not, which made the documented form the easy one.
  it.each([
    "cd /tmp; git push origin main",
    "cd /tmp && git push origin main",
    "pushd /tmp; git status",
    "cd ../other && git commit -am update",
  ])("runs a relocated compound Git command sandboxed in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
    });
  });

  // The exemption, which is what keeps a read-only probe written against the
  // request's own directory ordinary. Both forms provably reach the directory the
  // request already named, so there is no relocation to reason about.
  it.each([".", "SELF_CWD"])(
    "still auto-approves a probe that cd's to the request's own directory (%s)",
    async (target) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
      await createGitDirectory(join(cwd, ".git"));
      const command = `cd ${target === "SELF_CWD" ? cwd : target} && git status --short && git log --oneline -1`;

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    },
  );

  // A lone `cd` moves a shell this request does not keep, so it is not state
  // crossing into a later segment and stays ordinary.
  it("still auto-approves a cd with nothing after it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateRiskRequest("bash", { command: "cd /tmp" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  // The known-cwd fold (`cd-normalize.ts`). A leading literal `cd` followed
  // only by literal, read-only commands is statically decidable: the effective
  // directory is computable from data the analyser already holds, so the
  // segment chain no longer crosses segments and the command auto-approves.
  // The target is resolved lexically, never with `realpath`, so it does not have
  // to exist on disk — the last case pins that.
  it("folds an absolute cd into a tmpdir followed by a relative read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const target = await mkdtemp(join(tmpdir(), "pi-safety-cd-"));

    for (const rest of ["head -5 README.md", "cat README.md"]) {
      await expect(
        evaluateRiskRequest("bash", { command: `cd ${target} && ${rest}` }, cwd, config()),
      ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
    }
  });

  it("folds a relative single-name cd followed by a relative read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    await expect(
      evaluateRiskRequest("bash", { command: "cd repo && head -5 README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  it("folds a no-op cd chain (cd . / cd <request cwd>) followed by a read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    for (const command of ["cd . && ls", `cd ${cwd} && ls`]) {
      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    }
  });

  it("folds a literal cd target that was never created on disk", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const target = join(tmpdir(), "pi-safety-cd-never-created", "repo");

    await expect(
      evaluateRiskRequest("bash", { command: `cd ${target} && cat x` }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  // Everything the fold cannot prove stays a review. A VCS command after `cd` is
  // the sharpest case: implicit remotes are read from the request cwd, so a
  // folded cd would bind the wrong repository.
  // Cut 3: relocation reviews are gone — the runtime enforces with the
  // actual post-cd cwd, which is more exact than the static guess.
  it("runs a literal cd followed by a VCS command sandboxed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const target = await mkdtemp(join(tmpdir(), "pi-safety-cd-"));

    for (const command of [`cd ${target} && git status`, `cd ${target} && git log --oneline -1`]) {
      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    }
  });

  it.each([
    ["cd $DIR && cat x"],
    ['cd "$DIR" && cat x'],
    ["cd ~ && cat x"],
    ["cd /tmp/pi-safety-target/* && cat x"],
    ["cd .. && cat x"],
    ["cd a/../b && cat x"],
    ["cd - && cat x"],
    ["cd -- && cat x"],
    ["cd a b && cat x"],
    ["cd /tmp && export FOO=1 && echo $FOO"],
    ["cd /tmp && node -e 'console.log(1)'"],
    ['cd /tmp && bash -c "cd /etc && cat passwd"'],
  ])("runs a cd whose relocation is not provable sandboxed in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
    });
  });

  // Package runners and string interpreters read state the relocation
  // invalidates (a manifest, a lifecycle script, an inline program), so they are
  // context-dependent and block the fold too.
  it.each([
    ["npm test"],
    ["npx cowsay"],
    ["pnpm test"],
    ["yarn test"],
    ["make"],
    ["just x"],
    ["task x"],
    ["direnv allow"],
    ["eval x"],
    ["source x"],
  ])("runs a cd followed by context-dependent commands sandboxed in %s", async (rest) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    await expect(
      evaluateRiskRequest("bash", { command: `cd /tmp && ${rest}` }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  // A deletion executable after `cd` must not be folded even when it looks
  // harmless: the fold refuses that segment, the relocation stays visible, and
  // the chain is reviewed. A forced `rm` is caught by tier 1 and stays
  // at review; the unforced deletion executables are reviewed, not blocked —
  // the invariant being pinned here is "not folded into Skip".
  it("keeps a forced rm after a literal cd at review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const target = await mkdtemp(join(tmpdir(), "pi-safety-cd-"));

    await expect(
      evaluateRiskRequest("bash", { command: `cd ${target} && rm -rf x` }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "NeedsApproval" });
  });

  // Cut 3: the deletion carve-out is gone, so an unforced deletion after
  // `cd` runs and the sandbox denies out-of-root targets at runtime with
  // the actual post-cd cwd. A forced `rm` is caught by tier 1 and stays
  // at review.
  it.each(["rmdir x", "shred x", "unlink x", "truncate -s 0 x"])(
    "runs a deletion executable after a literal cd sandboxed in %s",
    async (rest) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
      const target = await mkdtemp(join(tmpdir(), "pi-safety-cd-"));

      await expect(
        evaluateRiskRequest("bash", { command: `cd ${target} && ${rest}` }, cwd, config()),
      ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
    },
  );

  // Cut 3: the second-changer review is gone with cross-segment state —
  // the runtime runs the chain under the real cwd.
  it("runs a second cd sandboxed in cd <a> && cd <b> && cat x", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const first = await mkdtemp(join(tmpdir(), "pi-safety-cd-a-"));
    const second = await mkdtemp(join(tmpdir(), "pi-safety-cd-b-"));

    await expect(
      evaluateRiskRequest(
        "bash",
        { command: `cd ${first} && cd ${second} && cat x` },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  // Program identity has to survive the wrapper that hosts the command. The inner
  // parse starts from a fresh executable context, so before this rule the only
  // segment that had seen `PATH=/tmp` was the shell — and the whole gate was one
  // `bash -c` away from not existing.
  // `PATH` decides which binary runs, so an untrusted host is inherited whole and
  // the refusal is final.
  it("inherits an untrusted host's program identity into a nested shell body in env PATH=/tmp /bin/bash -c 'git push origin main'", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateRiskRequest(
        "bash",
        { command: "env PATH=/tmp /bin/bash -c 'git push origin main'" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "block", risk: "Forbidden" });
  });

  // `GIT_DIR` does not change which binary runs, so the body keeps a trusted
  // program and inherits only the unproven surroundings. The relocation is
  // visible in the words and a human settles it.
  it("runs a relocating host sandboxed in env GIT_DIR=/tmp/other.git /bin/bash -c 'git push origin main'", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateRiskRequest(
        "bash",
        { command: "env GIT_DIR=/tmp/other.git /bin/bash -c 'git push origin main'" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  // A `remote.<name>.url` is not an inert setting: `ext::…` selects the external
  // remote-helper transport, which runs a program. Verified against real git at
  // this pin — the marker file was created while the classifier said `Skip`.
  // `parseGitRemoteTarget` rejects the same spelling when it appears as an
  // operand, and a config override never reaches that parser at all.
  it.each([
    "git -c remote.evil.url='ext::touch /tmp/pi-safety-marker' ls-remote evil",
    "git -c remote.evil.url='ext::touch /tmp/pi-safety-marker' commit -am x",
    "git -cuser.evil.url='ext::touch /tmp/pi-safety-marker' ls-remote evil",
  ])("refuses a config override that installs a remote helper in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateRiskRequest("bash", { command }, cwd, config()),
    ).resolves.not.toMatchObject({ action: "allow" });
  });

  // A `-c` whose value has no `=` is a form git itself rejects. A spelling the
  // parser cannot read is not a spelling it can clear.
  it.each(["git -c user.name push origin main", "git --config-env user.name push origin main"])(
    "runs a malformed config assignment sandboxed in %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
      await createGitDirectory(join(cwd, ".git"));

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    },
  );

  // A proven-dangerous segment keeps its disposition when an unrelated Git part
  // of the same command is unproven. The elevation is one-way: an unproven
  // context may raise `Skip` to a review, never lower a review.
  it("keeps a proven-dangerous disposition when an unproven Git context is also present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    const control = await evaluateRiskRequest(
      "bash",
      { command: "git status; rm -rf /tmp/pi-safety-victim" },
      cwd,
      config(),
    );
    const withUnproven = await evaluateRiskRequest(
      "bash",
      { command: "git -C /x status; rm -rf /tmp/pi-safety-victim" },
      cwd,
      config(),
    );

    expect(control).toMatchObject({ action: "prompt", risk: "NeedsApproval" });
    expect(withUnproven).toMatchObject({ action: "prompt", risk: "NeedsApproval" });
  });

  // `git --version` and friends take no value, relocate nothing and run nothing,
  // so they belong with the other provably safe global options. They were sent to
  // review for being unrecognised, which made the spelling decide: `git version`
  // auto-approved while `git --version` did not.
  it.each(["git --version", "git --help", "git -h", "git --no-pager --version"])(
    "still auto-approves an informational git option in %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
      await createGitDirectory(join(cwd, ".git"));

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    },
  );

  // Known gap, deliberately kept as a failing-by-omission marker rather than
  // deleted: `executableTrusted` is a Git-only mechanism, so an arbitrary
  // program reached by explicit path — here a fake `gh` — gets no identity
  // check at all and is auto-approved on the strength of its basename. Closing
  // this means deciding program identity for every executable, not just Git,
  // which is a larger design question than this fix takes on.
  it("KNOWN GAP: auto-approves an arbitrary program reached by path in ./gh pr checkout 123", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateRiskRequest("bash", { command: "./gh pr checkout 123" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
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
      risk: "Skip",
    });
  });

  it.each(["git init", "git init ."])(
    "keeps Git init as an ordinary sandbox action for %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-git-init-"));

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
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
      risk: "Skip",
    });
  });

  it.each(['git init ""', "git init ''"])(
    "does not statically reject an ordinary Git init operand in %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-empty-git-init-"));

      await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    },
  );

  it("leaves missing-repository Git mutations to the ordinary sandbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-no-repository-"));

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  it.each([
    "git add README.md; printf '#!/bin/sh\\n' > .git/hooks/pre-commit",
    "git add README.md > .git/hooks/pre-commit",
    'bash -c "git add README.md"',
    'fish -c "git add README.md"',
    "git add README.md | tee result.txt",
  ])("leaves compound Git shell effects to the ordinary sandbox in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".git", "config"), "");

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
    });
  });

  // Same Git-mutation shape, but the argument is a substitution, so the static
  // word list is not the argv that runs: the unclassifiable tier reviews it
  // instead of auto-running (the single-quoted forms above stay allow/LOW).
  it.each([
    'git add "$(printf README.md)"',
    'git add "$' + '{ touch .git/hooks/pre-commit; }"',
    'git add "$' + '{| touch .git/hooks/pre-commit; }"',
  ])("runs a substituted Git operand sandboxed in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".git", "config"), "");

    await expect(evaluateRiskRequest("bash", { command }, cwd, config())).resolves.toMatchObject({
      action: "allow",
      risk: "Skip",
    });
  });

  it("does not statically inspect Git metadata for an ordinary mutation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await writeFile(join(cwd, ".git"), "gitdir: /\n");

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  it("leaves Git metadata symlinks to the ordinary sandbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    await symlink("/", join(cwd, ".git"));

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
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
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
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
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  it("does not add metadata roots for an invalid back-pointer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    const unrelated = await mkdtemp(join(tmpdir(), "pi-safety-unrelated-"));
    await writeFile(join(cwd, ".git"), `gitdir: ${unrelated}\n`);
    await writeFile(join(unrelated, "gitdir"), `${join(cwd, ".git")}\n`);

    await expect(
      evaluateRiskRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
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
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
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
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  it("defers private shell network targets to the sandbox boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    const decision = await evaluateRiskRequest(
      "bash",
      { command: "curl http://127.0.0.1/admin" },
      cwd,
      config(),
    );

    expect(decision).toMatchObject({ action: "allow", risk: "Skip" });
  });

  it("defers private shell targets to the runtime boundary when the sandbox is disabled", async () => {
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
      action: "allow",
      risk: "Skip",
    });
  });

  it("reviews private WebFetch targets for the runtime boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    for (const url of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      await expect(evaluateRiskRequest("WebFetch", { url }, cwd, config())).resolves.toMatchObject({
        action: "prompt",
        risk: "Forbidden",
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
      risk: "NeedsApproval",
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

  it("rejects the retired require_escalated parameter with a fixable argument error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    // The parameter no longer exists in the tool schema. A stale model that
    // still sends it must be told which field is wrong, not which field to add.
    const decision = await evaluateRiskRequest(
      "bash",
      { command: "git status --porcelain", sandbox_permissions: "require_escalated" },
      cwd,
      config(),
    );
    expect(decision).toMatchObject({ action: "block", risk: "Forbidden" });
    if (decision.action !== "block") throw new Error("expected a block");
    expect(decision.reason).toContain("sandbox_permissions");
    expect(isPermissionArgumentError(decision.reason)).toBe(true);
  });

  it("rejects require_escalated even when additional_permissions is also present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));

    const decision = await evaluateRiskRequest(
      "bash",
      {
        command: "git status --porcelain",
        sandbox_permissions: "require_escalated",
        additional_permissions: { file_system: { write: [join(cwd, "out")] } },
        justification: "Write the build artifact",
      },
      cwd,
      config(),
    );
    expect(decision).toMatchObject({ action: "block", risk: "Forbidden" });
    if (decision.action !== "block") throw new Error("expected a block");
    expect(decision.reason).toContain("require_escalated");
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
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
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

    expect(decision).toMatchObject({ action: "prompt", risk: "Skip" });
    expect(decision).not.toHaveProperty("networkHosts");
  });

  it("summarizes requests without including write content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-default-"));
    // Cut 3: an outside-roots write no longer prompts on its own, so drive
    // the prompt through a rules-ask — the anti-leak property belongs to
    // `summarize`, not to any particular review trigger.
    const decision = await evaluateRiskRequest(
      "write",
      { path: "/var/tmp/out.txt", content: "DO_NOT_RENDER_THIS_SECRET" },
      cwd,
      config({ rules: [{ action: "ask", tool: "write" }] }),
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
        risk: "Skip",
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
        risk: "Skip",
      });
    }
  });

  it("leaves protected metadata deletion to the runtime sandbox", async () => {
    // Cut 3: the deletion carve-out is gone, so `rm .git/HEAD` runs and
    // SRT denies it via the protected write roots. Ordinary files run too.
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-del-"));
    await expect(
      evaluateRiskRequest("bash", { command: "rm .git/HEAD" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
    await expect(
      evaluateRiskRequest("bash", { command: "rm .env" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
  });

  it("reviews forced rm even when its target stays inside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-del-"));
    await expect(
      evaluateRiskRequest("bash", { command: "rm -rf build" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "NeedsApproval" });
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
      risk: "NeedsApproval",
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
    ).resolves.toMatchObject({ action: "block", risk: "Forbidden" });
    await expect(
      evaluateRiskRequest("request_permissions", { permissions: {} }, cwd, config()),
    ).resolves.toMatchObject({ action: "block", risk: "Forbidden" });
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
        risk: "Skip",
      });
    }
  });

  it("uses exact-name and glob rules to opt external tools into review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-mcp-"));
    const exact = config({ rules: [{ action: "ask", tool: "gitee__create_issue" }] });
    await expect(
      evaluateRiskRequest("gitee__create_issue", { title: "x" }, cwd, exact),
    ).resolves.toMatchObject({ action: "prompt", risk: "NeedsApproval" });
    await expect(
      evaluateRiskRequest("gitee__create_pr", { title: "y" }, cwd, exact),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });

    const globbed = config({ rules: [{ action: "ask", tool: "mcp__*" }] });
    await expect(
      evaluateRiskRequest("mcp__github__get_issue", { owner: "a" }, cwd, globbed),
    ).resolves.toMatchObject({ action: "prompt", risk: "NeedsApproval" });
    await expect(
      evaluateRiskRequest("gitee__create_issue", { title: "x" }, cwd, globbed),
    ).resolves.toMatchObject({ action: "allow", risk: "Skip" });
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
      evaluateDenyRulesOnly("WebFetch", { url: "https://example.com/docs" }, cwd, hostConfig),
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

  it("stamps permission_amendment on request_permissions prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-residual-amend-"));
    const decision = await evaluateRiskRequest(
      "request_permissions",
      { permissions: { file_system: { write: [join(cwd, "out")] } }, scope: "turn" },
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
    expect(decision).toMatchObject({ action: "allow", risk: "Skip" });
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
      risk: "Skip",
      reason: "Allowed by permissions rule",
    });
    expect(decision).not.toHaveProperty("residuals");
  });

  it("stamps risk_not_skip on dangerous/HARD prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-residual-hard-"));
    const decision = await evaluateRiskRequest("bash", { command: "rm -rf build" }, cwd, config());
    expect(decision).toMatchObject({
      action: "prompt",
      risk: "NeedsApproval",
      residuals: expect.arrayContaining(["risk_not_skip"]),
    });
    // A proven-dangerous verdict is not a failed proof: the review-cause
    // vocabulary stays out of `static_risk` buckets.
    expect(decision).toMatchObject({
      residuals: expect.not.arrayContaining(["substitution_unproven", "lex_incomplete"]),
    });
  });

  it("allows the last substitution shape (cut 3: no cause channel)", async () => {
    // Cut 3 deleted the substitution review with Tier 4: a live but
    // harmless `$(date)` runs sandboxed. Only a dangerous body still
    // reviews (dangerousSubstitution cases above).
    const cases = ['echo "$(date)"'];
    for (const command of cases) {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-residual-cause-"));
      const decision = await evaluateRiskRequest("bash", { command }, cwd, config());
      expect(decision, command).toMatchObject({
        action: "allow",
        risk: "Skip",
      });
    }
  });

  it("allows a command whose only unproven clauses are heredocs (first cut)", async () => {
    // Codex alignment Q3 removal, cut 1: heredoc bodies already passed the
    // Tier 1 dangerous screen, so the heredoc itself is not a review. Mixed
    // shapes (heredoc + substitution) still fail closed — see
    // permissions-substitution.test.ts.
    //
    // Step 3: the mixed-queue shape reviews. Its queue is unprovable to the
    // grammar (a second bare opener misparses), so the whole command
    // abstains — even though the $y body is harmless. Fail-closed on the
    // queue, not on the bodies; the clean single-heredoc shape still Skips.
    for (const command of ["cat <<'EOF'\nx\nEOF"]) {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-heredoc-allow-"));
      const decision = await evaluateRiskRequest("bash", { command }, cwd, config());
      expect(decision, command).toMatchObject({ action: "allow", risk: "Skip" });
    }
    {
      const command = "cat <<A <<'B'\n$y\nA\nx\nB";
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-heredoc-allow-"));
      const decision = await evaluateRiskRequest("bash", { command }, cwd, config());
      expect(decision, command).toMatchObject({ action: "prompt", risk: "NeedsApproval" });
    }
  });

  it("allows signals (cut 2: Tier 2 is gone)", async () => {
    // Codex alignment: codex never gated Unix signals. Inert `GIT_*`
    // environments still prompt at this layer via the `unprovenGit`
    // elevation — that is cut 3, pinned by the table above.
    for (const command of ["kill 4321", "pkill -9 node"]) {
      const cwd = await mkdtemp(join(tmpdir(), "pi-safety-cut2-allow-"));
      const decision = await evaluateRiskRequest("bash", { command }, cwd, config());
      expect(decision, command).toMatchObject({ action: "allow", risk: "Skip" });
    }
  });

  it("names the substitution a dangerous command hid in", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-subst-reason-"));
    const decision = await evaluateRiskRequest(
      "bash",
      { command: 'echo "$(rm -rf /)"' },
      cwd,
      config(),
    );
    // The reason is evidence about the action itself (it travels into the
    // Guardian packet), not a process label like a review cause — which is
    // why this is allowed to change a packet where P0-1 changes only metrics.
    expect(decision).toMatchObject({
      action: "prompt",
      risk: "NeedsApproval",
      reason: "Dangerous command inside shell substitution: rm -rf /",
      residuals: ["action_review", "risk_not_skip"],
    });
  });
});
