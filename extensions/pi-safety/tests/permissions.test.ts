import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSafetyConfigPath } from "../src/filesystem-policy.ts";
import { isPathAllowed } from "../src/permissions/paths.ts";
import {
  analyzeShellGitNetwork,
  classifyRisk,
  extractShellNetworkHosts,
  isPublicNetworkHost,
  normalizeToolCall,
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
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-safety-outside-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "pi-safety-"));
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

describe("Git network parsing", () => {
  it.each([
    ["git push origin main", true],
    ["/usr/bin/git push origin main", true],
    ["env git push origin main", true],
    ["command git push origin main", true],
    ["sudo -u root git push origin main", true],
    ["X=1 git push origin main", true],
    ["do git push origin main", true],
    ["git fetch origin", false],
    ["git push https://github.com/owner/repo.git main", false],
    ['bash -c "git push origin main"', false],
    ["git push origin main; git status", false],
    ["git push origin main > push.log", false],
  ] as const)("identifies one parsed implicit Git push in %s", (command, expected) => {
    expect(analyzeShellGitNetwork(command).directImplicitPurpose === "push").toBe(expected);
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
            path: defaultSafetyConfigPath(),
          },
          "/work/repo",
        ),
      ),
    ).toBe("HARD");
    expect(
      classifyRisk(
        normalizeToolCall("write", { path: "/opt/pi/extensions/pi-safety/config.json" }, "/work"),
        false,
        [],
        ["/opt/pi/extensions/pi-safety/config.json"],
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
    ["time rm -rf build", "HARD"],
    ["/usr/bin/time rm -rf build", "HARD"],
    ["env time rm -rf build", "HARD"],
    ["sudo time rm -rf build", "HARD"],
    ["time -p rm -rf build", "HARD"],
    ["time -- rm -rf build", "HARD"],
    ["time -f %e rm -rf build", "HARD"],
    ["time -o /tmp/out rm -rf build", "HARD"],
    // Delegating wrappers hide the real command behind a fixed-arity option
    // grammar; stripping them is what exposes the nested forced removal.
    ["timeout 1 rm -rf build", "HARD"],
    ["timeout 30s rm -rf build", "HARD"],
    ["timeout --foreground 30 rm -rf build", "HARD"],
    ["timeout -k 5 30 rm -rf build", "HARD"],
    ["timeout -s TERM 30 rm -rf build", "HARD"],
    ["nice rm -rf build", "HARD"],
    ["nice -n 10 rm -rf build", "HARD"],
    ["nice --adjustment 5 rm -rf build", "HARD"],
    ["stdbuf -o0 rm -rf build", "HARD"],
    ["stdbuf --output=0 rm -rf build", "HARD"],
    ["unbuffer rm -rf build", "HARD"],
    // `su`/`doas` carry an identity operand and a per-platform inline-command
    // grammar, so the real command is not provable from the static words.
    ["su root -c 'rm -rf /tmp/x'", "REVIEW"],
    ["doas rm -rf /tmp/x", "REVIEW"],
    // A wrapper with no provable command operand names no runtime program.
    ["timeout", "REVIEW"],
    ["nice", "REVIEW"],
    ["timeout --help", "REVIEW"],
    ["time", "REVIEW"],
    ["time -f", "REVIEW"],
    ["nohup", "REVIEW"],
    ["command", "REVIEW"],
    ["sudo -u", "REVIEW"],
    ["sudo -C", "REVIEW"],
    // An option whose value could be read as the executable is not provable:
    // unknown `env`/`sudo` value-taking options and non-canonical durations.
    ["env -S 'rm -rf /tmp/x'", "REVIEW"],
    ["env -P /usr/bin rm -rf /tmp/x", "REVIEW"],
    ["sudo -D /tmp rm -rf /tmp/x", "REVIEW"],
    ["sudo -R / rm -rf /tmp/x", "REVIEW"],
    ["sudo -T 1 rm -rf /tmp/x", "REVIEW"],
    ["timeout 1e3 rm -rf /tmp/x", "REVIEW"],
    ["timeout 0x1 rm -rf /tmp/x", "REVIEW"],
    ["timeout 1.2.3 rm -rf /tmp/x", "REVIEW"],
    // GNU `nice` accepts a bare adjustment operand; it must not become the
    // executable.
    ["nice +5 rm -rf /tmp/x", "HARD"],
    ["nice -10 rm -rf /tmp/x", "HARD"],
    ["nice +5 ls -la", "LOW"],
    // A backslash-newline is a line continuation removed before word
    // splitting, so it must not split the command word apart.
    ["r\\\nm -f /tmp/x", "HARD"],
    ["rm \\\n-rf /tmp/x", "HARD"],
    ["timeout \\\n1 rm -rf /tmp/x", "HARD"],
    // A redirection is shell syntax: `>out rm -f x` runs `rm`, it does not run
    // a program named `>out`.
    [">out rm -f /tmp/x", "HARD"],
    ["2>err rm -f /tmp/x", "HARD"],
    ["<in rm -f /tmp/x", "HARD"],
    [">>log rm -rf /tmp/x", "HARD"],
    ["FOO=1 >out rm -rf /tmp/x", "HARD"],
    ["ls -la >out", "LOW"],
    ["cat <in", "LOW"],
    // An unterminated lexical construct is unproven, not safe. A proven
    // danger still outranks the lex defect, so `rm -f x \` stays HARD.
    [">out", "REVIEW"],
    ["echo 'unclosed", "REVIEW"],
    ['echo "unclosed', "REVIEW"],
    ["echo \\", "REVIEW"],
    ["echo \u0000", "REVIEW"],
    ["rm -f x \\", "HARD"],
    // Git can run a program the argv never names: a shell alias, a config key
    // whose value is an executable, a `GIT_*` override, or a subcommand that
    // takes a command. Codex has no Git arm, so nothing upstream catches these.
    ["git -c alias.x='!rm -f /tmp/x' x", "REVIEW"],
    ["git -calias.x='!rm -f /tmp/x' x", "REVIEW"],
    ["git -c core.pager='rm -f /tmp/x' log", "REVIEW"],
    ["git --config-env=core.pager=EVIL log", "REVIEW"],
    ["git -c credential.helper='!rm -f /tmp/x' status", "REVIEW"],
    ["GIT_EXTERNAL_DIFF='rm -f /tmp/x' git diff", "REVIEW"],
    ["GIT_PAGER='rm -f /tmp/x' git log", "REVIEW"],
    ["GIT_EDITOR='rm -f /tmp/x' git commit", "REVIEW"],
    ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x git x", "REVIEW"],
    ["git filter-branch --tree-filter 'rm -f /tmp/x'", "REVIEW"],
    ["git bisect run rm -f /tmp/x", "REVIEW"],
    ["git hook run post-checkout", "REVIEW"],
    ["git submodule foreach 'rm -f /tmp/x'", "REVIEW"],
    // A config value that names no executable leaves the argv provable.
    ["git -c core.quotepath=false status", "LOW"],
    ["git -c user.name=Foo commit -m x", "LOW"],
    ["git -c init.defaultBranch=main init", "LOW"],
    ["git bisect start", "LOW"],
    ["git hook list", "LOW"],
    ["git submodule status", "LOW"],
    ["GIT_AUTHOR_NAME=x git commit -m x", "LOW"],
    // Process control is fully determined by its argv but is not confined by
    // the filesystem or network policy, so it reviews rather than allowing.
    // fx treats the same primitive as `process_or_system`
    // (`command_effect.zig:894-906`).
    ["kill -9 1", "REVIEW"],
    ["pkill -9 node", "REVIEW"],
    ["killall node", "REVIEW"],
    ["timeout 1 kill -9 1", "REVIEW"],
    ["sudo kill -9 1", "REVIEW"],
    // A proven danger still outranks a process-control review.
    ["kill -9 1; rm -rf /tmp/x", "HARD"],
    // Process inspection is not process control.
    ["ps aux", "LOW"],
    ["pgrep node", "LOW"],
    // A network grant authorizes the connection, not the API semantics carried
    // over it, so a mutating control-plane verb is a proven external effect.
    ["git config --global alias.x '!rm -f /tmp/x'", "REVIEW"],
    ["git config alias.dg '!rm -f /tmp/x'", "REVIEW"],
    // A value-taking global option must be consumed before the subcommand is
    // read, or its value is mistaken for the subcommand.
    ["git -C /tmp bisect run rm -f /tmp/x", "REVIEW"],
    ["git --git-dir /tmp/r bisect run rm -f /tmp/x", "REVIEW"],
    ["git -C /tmp -c alias.x='!rm -f /tmp/x' x", "REVIEW"],
    ["git --exec-path=/tmp/x custom-subcommand", "REVIEW"],
    ["GIT_EXEC_PATH=/tmp/x git custom-subcommand", "REVIEW"],
    ["GIT_CONFIG_PARAMETERS='alias.x=!rm -f /tmp/x' git x", "REVIEW"],
    ["git -c filter.blob.clean='rm -f /tmp/x' status", "REVIEW"],
    ["git -c diff.mydriver.command='rm -f /tmp/x' diff", "REVIEW"],
    ["git -c interactive.diffFilter=rm status", "REVIEW"],
    ["git -c ALIAS.X='!rm -f /tmp/x' x", "REVIEW"],
    ["git --config-env core.pager=EVIL log", "REVIEW"],
    ["git -C /tmp status", "LOW"],
    ["git --work-tree ../t status", "LOW"],
    ["git -c filter.blob.required=false status", "LOW"],
    // `kill` reporting forms do not signal; a mixed form still reviews.
    ["kill -l", "LOW"],
    ["kill -L", "LOW"],
    ["kill --version", "LOW"],
    ["kill -l -9 1", "REVIEW"],
    ["kill -TERM -1", "REVIEW"],
    // Read-only control-plane verbs must not be caught by the mutation table.
    ["aws s3 ls s3://bucket", "LOW"],
    ["aws ec2 describe-instances", "LOW"],
    ["gcloud compute instances list", "LOW"],
    ["kubectl get pods", "LOW"],
    ["helm list", "LOW"],
    ["npm ls", "LOW"],
    ["vercel --version", "LOW"],
    // A verb used as an option value is not a verb: `terraform plan -out apply`.
    ["terraform plan -out apply", "LOW"],
    ["trap 'rm -rf /tmp/x' EXIT", "HARD"],
    ['bash -lc "rm -rf build"', "HARD"],
    ['sh -c "rm -f x"', "HARD"],
    // `trap ACTION SIGNAL` stores shell code to run later, so the action is a
    // program the static argv never showed: unclassifiable, hence REVIEW.
    ["trap 'ls' EXIT", "REVIEW"],
    ["php -r 'system(\"ls\");'", "REVIEW"],
    ["deno eval 'console.log(1)'", "REVIEW"],
    ["perl -wE 'say 1'", "REVIEW"],
    ["php -dr 'system(\"ls\");'", "REVIEW"],
    // Stripping a delegating wrapper must not disturb ordinary wrapped reads.
    ["timeout 1 ls -la", "LOW"],
    ["nice -n 5 git status", "LOW"],
    // A word after a value-taking option is that option's value, and a bare `-`
    // is the stdin sentinel: the program comes from a pipe, not the argv.
    ["bash -o pipefail", "REVIEW"],
    ["python -X utf8", "REVIEW"],
    ["deno run -", "REVIEW"],
    // The operand behind an option's value is still read: a fixed argv.
    ["bash -o pipefail script.sh", "LOW"],
    ["php -d memory_limit=1G script.php", "LOW"],
    ["rm -r build", "LOW"],
    ["rm build/a.ts", "LOW"],
    ["rmdir build/cache", "LOW"],
    ["unlink build/a.ts", "LOW"],
    ["shred build/a.ts", "LOW"],
    ["truncate -s 0 build/a.ts", "LOW"],
    ["rm -- -f build", "LOW"],
    ["git push origin feature", "HARD"],
    ["do git push origin feature", "HARD"],
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
    // Expansion in the *command* position rewrites which binary runs, so the
    // argv read here is not the argv that executes. `{rm,echo} -f build`
    // expands to `rm echo -f build`, and rm deletes `build` and `echo`.
    ["{rm,echo} -f build", "REVIEW"],
    ["r?m -f build", "REVIEW"],
    ["g{hc,cloud} pr merge 1", "REVIEW"],
    // `include.path` / `includeIf.<condition>.path` make Git parse another
    // config file, which can define `alias.<name> = !cmd` — the executable
    // entry point an inline `git -c alias.x=` already guards, one hop away.
    ["git -c include.path=/tmp/gcfg x", "REVIEW"],
    ["git -c includeIf.hasconfig:remote.*.path=/tmp/gcfg x", "REVIEW"],
    // A named module is not a script path: what runs is the module's
    // `__main__`, whose contents are not in argv.
    ["python3 -m pip install requests", "REVIEW"],
    ["python3 -m pytest", "REVIEW"],
    // A global option ahead of the subcommand used to hide it: the scan read
    // the option's value as the subcommand, so `--prefix /tmp` was compared
    // against the verb table and `install` was never seen.
    ["npm --prefix /tmp install lodash", "HARD"],
    ["npm install lodash", "HARD"],
    // `[` is the one glob metacharacter that is also a real builtin.
    ["[ -f README.md ]", "LOW"],
    // zsh expands a leading `=` to the full path of the command, so `=rm` is
    // rm. Verified in a real zsh.
    ["zsh -c '=rm -f /tmp/x'", "REVIEW"],
    // Program-valued config keys the earlier name list did not cover. The
    // check is now an allowlist of scalar key segments, so an unlisted key is
    // unproven rather than allowed.
    ["git -c 'credential.https://x.com.helper=!echo EVIL' credential fill", "REVIEW"],
    ["git -c 'pager.foo.cmd=!echo EVIL' log", "REVIEW"],
    // `alias.<name>` has an author-chosen tail, so its last segment carries no
    // information: `alias.name` ends in a scalar name and is still a program.
    ["git -c 'alias.name=!echo EVIL' name", "REVIEW"],
    ["git -c 'alias.status=!echo EVIL' status", "REVIEW"],
    ["git config alias.name '!echo EVIL'", "REVIEW"],
    ["git -c 'pager.name=!echo EVIL' log", "REVIEW"],
    ["git -c 'color.pager=!echo EVIL' log", "REVIEW"],
    // Scalar keys stay allowed, including the URL-scoped and per-branch forms
    // the allowlist matches on the last segment.
    ["git -c user.name=Ada commit -m x", "LOW"],
    ["git -c core.autocrlf=false status", "LOW"],
    ["git -c init.defaultbranch=main status", "LOW"],
    ["git config --global user.name Ada", "LOW"],
    // A noun-led package manager puts its verb after `workspace <name>`.
    ["yarn workspace foo add lodash", "HARD"],
    // `--help` is a value here, not a terminal flag, so the invocation goes on
    // to create the pull request.
    ["gh pr create --title --help --body x", "HARD"],
    // The key comes after a value-taking option, so `--file`'s path must not
    // be read as the key.
    ["git config --file user.name --add core.pager '!echo EVIL'", "REVIEW"],
    // `--edit` opens the config in $GIT_EDITOR.
    ["git config --edit", "REVIEW"],
    // A terminal flag is only terminal where it cannot be a value.
    ["gh --version", "LOW"],
    // `--help` here is `--as`'s value, so the invocation reaches `delete`
    // rather than printing help. Verified against a real kubectl.
    ["kubectl --as --help delete pod demo", "REVIEW"],
    // Same shape in the interpreter analysis: `-W` takes the value, and python
    // goes on to run the program it is handed.
    ["python3 -W --help", "REVIEW"],
    // An attached value cannot shift an operand, so it needs no table entry.
    ["kubectl -n=default get pods", "LOW"],
    ["git -c user.email=a@b status", "LOW"],
    ["git -c status.short=true status", "LOW"],
    ["git -c push.default=simple status", "LOW"],
  ] as const)("classifies sandboxed Bash %s as %s", (command, expected) => {
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe(expected);
  });

  it.each(['echo "$(rm -rf build)"', "echo `rm -rf build`"])(
    "requires review for executable shell substitution in %s",
    (command) => {
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe("REVIEW");
    },
  );

  it("classifies wrapper option parsing without catastrophic backtracking", () => {
    // A nested-quantifier regex on the `stdbuf` attached-value form made a
    // 25-character token take seconds. Commands are agent-authored, so this
    // input is reachable and must stay cheap.
    for (const length of [20, 25, 40, 80]) {
      const command = `stdbuf -o${"a".repeat(length)}! rm -rf build`;
      const started = performance.now();
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe("REVIEW");
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

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
