import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPathAllowed } from "../src/permissions/paths.ts";
import {
  analyzeShellGitNetwork,
  classifyRisk,
  extractShellNetworkHosts,
  isPublicNetworkHost,
  normalizeToolCall,
} from "../src/permissions/risk.ts";
import { matchRules, type PermissionRequest } from "../src/permissions/rules.ts";
import { defaultSafetyConfigPath } from "../src/policy-primitives.ts";

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
    ).toBe("Skip");
  });

  it("keeps public WebFetch low and fails closed for invalid targets", () => {
    expect(
      classifyRisk(
        normalizeToolCall("WebFetch", { url: "https://example.com/docs" }, "/work/repo"),
      ),
    ).toBe("Skip");
    for (const input of [
      {},
      { url: "" },
      { url: "file:///etc/passwd" },
      { url: "ftp://example.com" },
    ]) {
      expect(classifyRisk(normalizeToolCall("WebFetch", input, "/work/repo"))).toBe("Forbidden");
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
    expect(classifyRisk(normalizeToolCall("WebFetch", { url }, "/work/repo"))).toBe("Forbidden");
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
      "Skip",
    );
    expect(
      classifyRisk(normalizeToolCall("edit", { path: ".pi/permissions.json" }, "/work/repo")),
    ).toBe("Skip");
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
    ).toBe("Forbidden");
    expect(
      classifyRisk(
        normalizeToolCall("write", { path: "/opt/pi/extensions/pi-safety/config.json" }, "/work"),
        false,
        [],
        ["/opt/pi/extensions/pi-safety/config.json"],
      ),
    ).toBe("Forbidden");
  });

  it.each([
    ["pwd", "Skip"],
    ["ls -la", "Skip"],
    ["cat README.md", "Skip"],
    ["grep -rn TODO src", "Skip"],
    ["rg --no-config TODO src", "Skip"],
    ["rg -- --no-config src", "Skip"],
    ["/tmp/cat README.md", "Skip"],
    ["npm test", "Skip"],
    ["kubectl version", "Skip"],
    ["terraform version", "Skip"],
    ["helm version", "Skip"],
    ["ansible --version", "Skip"],
  ] as const)("classifies simple Bash %s as %s", (command, expected) => {
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe(expected);
  });

  it.each([
    ["cat 'README.md'", "Skip"],
    ["cat README\\.md", "Skip"],
    ["cat README.md; pwd", "Skip"],
    ["cat README.md && pwd", "Skip"],
    ["cat README.md || pwd", "Skip"],
    ["cat README.md | wc", "Skip"],
    ["cat README.md &", "Skip"],
    ["cat README.md\npwd", "Skip"],
    ["cat README.md > copy.txt", "Skip"],
    ["cat $(pwd)", "NeedsApproval"],
    ["bash -c 'pwd'", "Skip"],
    ["rm -rf build", "Forbidden"],
    ["rm --force build", "Forbidden"],
    ["rm -f build/a.ts", "Forbidden"],
    ["sudo rm -rf build", "Forbidden"],
    ["env -i rm -rf build", "Forbidden"],
    ["time rm -rf build", "Forbidden"],
    ["/usr/bin/time rm -rf build", "Forbidden"],
    ["env time rm -rf build", "Forbidden"],
    ["sudo time rm -rf build", "Forbidden"],
    ["time -p rm -rf build", "Forbidden"],
    ["time -- rm -rf build", "Forbidden"],
    ["time -f %e rm -rf build", "Forbidden"],
    ["time -o /tmp/out rm -rf build", "Forbidden"],
    // Delegating wrappers hide the real command behind a fixed-arity option
    // grammar; stripping them is what exposes the nested forced removal.
    ["timeout 1 rm -rf build", "Forbidden"],
    ["timeout 30s rm -rf build", "Forbidden"],
    ["timeout --foreground 30 rm -rf build", "Forbidden"],
    ["timeout -k 5 30 rm -rf build", "Forbidden"],
    ["timeout -s TERM 30 rm -rf build", "Forbidden"],
    ["nice rm -rf build", "Forbidden"],
    ["nice -n 10 rm -rf build", "Forbidden"],
    ["nice --adjustment 5 rm -rf build", "Forbidden"],
    ["stdbuf -o0 rm -rf build", "Forbidden"],
    ["stdbuf --output=0 rm -rf build", "Forbidden"],
    ["unbuffer rm -rf build", "Forbidden"],
    // `su`/`doas` carry an identity operand and a per-platform inline-command
    // grammar, so the real command is not provable from the static words.
    ["su root -c 'rm -rf /tmp/x'", "NeedsApproval"],
    ["doas rm -rf /tmp/x", "NeedsApproval"],
    // A wrapper with no provable command operand names no runtime program.
    ["timeout", "NeedsApproval"],
    ["nice", "NeedsApproval"],
    ["timeout --help", "NeedsApproval"],
    ["time", "NeedsApproval"],
    ["time -f", "NeedsApproval"],
    ["nohup", "NeedsApproval"],
    ["command", "NeedsApproval"],
    ["sudo -u", "NeedsApproval"],
    ["sudo -C", "NeedsApproval"],
    // An option whose value could be read as the executable is not provable:
    // unknown `env`/`sudo` value-taking options and non-canonical durations.
    ["env -S 'rm -rf /tmp/x'", "NeedsApproval"],
    ["env -P /usr/bin rm -rf /tmp/x", "NeedsApproval"],
    ["sudo -D /tmp rm -rf /tmp/x", "NeedsApproval"],
    ["sudo -R / rm -rf /tmp/x", "NeedsApproval"],
    ["sudo -T 1 rm -rf /tmp/x", "NeedsApproval"],
    ["timeout 1e3 rm -rf /tmp/x", "NeedsApproval"],
    ["timeout 0x1 rm -rf /tmp/x", "NeedsApproval"],
    ["timeout 1.2.3 rm -rf /tmp/x", "NeedsApproval"],
    // GNU `nice` accepts a bare adjustment operand; it must not become the
    // executable.
    ["nice +5 rm -rf /tmp/x", "Forbidden"],
    ["nice -10 rm -rf /tmp/x", "Forbidden"],
    ["nice +5 ls -la", "Skip"],
    // A backslash-newline is a line continuation removed before word
    // splitting, so it must not split the command word apart.
    ["r\\\nm -f /tmp/x", "Forbidden"],
    ["rm \\\n-rf /tmp/x", "Forbidden"],
    ["timeout \\\n1 rm -rf /tmp/x", "Forbidden"],
    // A redirection is shell syntax: `>out rm -f x` runs `rm`, it does not run
    // a program named `>out`.
    [">out rm -f /tmp/x", "Forbidden"],
    ["2>err rm -f /tmp/x", "Forbidden"],
    ["<in rm -f /tmp/x", "Forbidden"],
    [">>log rm -rf /tmp/x", "Forbidden"],
    ["FOO=1 >out rm -rf /tmp/x", "Forbidden"],
    ["ls -la >out", "Skip"],
    ["cat <in", "Skip"],
    // An unterminated lexical construct is unproven, not safe. A proven
    // danger still outranks the lex defect, so `rm -f x \` stays HARD.
    [">out", "NeedsApproval"],
    ["echo 'unclosed", "NeedsApproval"],
    ['echo "unclosed', "NeedsApproval"],
    ["echo \\", "NeedsApproval"],
    ["echo \u0000", "NeedsApproval"],
    ["rm -f x \\", "Forbidden"],
    // Git can run a program the argv never names: a shell alias, a config key
    // whose value is an executable, a `GIT_*` override, or a subcommand that
    // takes a command. Codex has no Git arm, so nothing upstream catches these.
    ["git -c alias.x='!rm -f /tmp/x' x", "NeedsApproval"],
    ["git -calias.x='!rm -f /tmp/x' x", "NeedsApproval"],
    ["git -c core.pager='rm -f /tmp/x' log", "NeedsApproval"],
    ["git --config-env=core.pager=EVIL log", "NeedsApproval"],
    ["git -c credential.helper='!rm -f /tmp/x' status", "NeedsApproval"],
    ["GIT_EXTERNAL_DIFF='rm -f /tmp/x' git diff", "NeedsApproval"],
    ["GIT_PAGER='rm -f /tmp/x' git log", "NeedsApproval"],
    ["GIT_EDITOR='rm -f /tmp/x' git commit", "NeedsApproval"],
    ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x git x", "NeedsApproval"],
    ["git filter-branch --tree-filter 'rm -f /tmp/x'", "NeedsApproval"],
    ["git bisect run rm -f /tmp/x", "NeedsApproval"],
    ["git hook run post-checkout", "NeedsApproval"],
    ["git submodule foreach 'rm -f /tmp/x'", "NeedsApproval"],
    // A config value that names no executable leaves the argv provable.
    ["git -c core.quotepath=false status", "Skip"],
    ["git -c user.name=Foo commit -m x", "Skip"],
    ["git -c init.defaultBranch=main init", "Skip"],
    ["git bisect start", "Skip"],
    ["git hook list", "Skip"],
    ["git submodule status", "Skip"],
    // A `GIT_*` assignment means Git may read configuration this layer has not
    // seen — an alias, a hook directory, a filter — so the argv is not provable
    // and the tier-4 review applies. This covers `GIT_AUTHOR_NAME`, which names no
    // program and was `Skip` until the environment was examined for what it can
    // change rather than for whether it substitutes an executable. The reviewer
    // settles a commit whose author identity is being overridden.
    //
    // `EDITOR`, `VISUAL` and `PAGER` are the sharper case and are absent from this
    // table on purpose: Git falls back to them when the `GIT_`-prefixed variable
    // is unset, so they name a program Git runs. `EDITOR=/tmp/evil git commit` is
    // covered in `risk-policy.test.ts`.
    ["GIT_AUTHOR_NAME=x git commit -m x", "NeedsApproval"],
    ["GIT_TRACE=1 git status", "NeedsApproval"],
    ["GIT_OPTIONAL_LOCKS=0 git status", "NeedsApproval"],
    // Process control is fully determined by its argv but is not confined by
    // the filesystem or network policy, so it reviews rather than allowing.
    // fx treats the same primitive as `process_or_system`
    // (`command_effect.zig:894-906`).
    ["kill -9 1", "NeedsApproval"],
    ["pkill -9 node", "NeedsApproval"],
    ["killall node", "NeedsApproval"],
    ["timeout 1 kill -9 1", "NeedsApproval"],
    ["sudo kill -9 1", "NeedsApproval"],
    // A proven danger still outranks a process-control review.
    ["kill -9 1; rm -rf /tmp/x", "Forbidden"],
    // Process inspection is not process control.
    ["ps aux", "Skip"],
    ["pgrep node", "Skip"],
    // A network grant authorizes the connection, not the API semantics carried
    // over it, so a mutating control-plane verb is a proven external effect.
    ["git config --global alias.x '!rm -f /tmp/x'", "NeedsApproval"],
    ["git config alias.dg '!rm -f /tmp/x'", "NeedsApproval"],
    // A value-taking global option must be consumed before the subcommand is
    // read, or its value is mistaken for the subcommand.
    ["git -C /tmp bisect run rm -f /tmp/x", "NeedsApproval"],
    ["git --git-dir /tmp/r bisect run rm -f /tmp/x", "NeedsApproval"],
    ["git -C /tmp -c alias.x='!rm -f /tmp/x' x", "NeedsApproval"],
    ["git --exec-path=/tmp/x custom-subcommand", "NeedsApproval"],
    ["GIT_EXEC_PATH=/tmp/x git custom-subcommand", "NeedsApproval"],
    ["GIT_CONFIG_PARAMETERS='alias.x=!rm -f /tmp/x' git x", "NeedsApproval"],
    ["git -c filter.blob.clean='rm -f /tmp/x' status", "NeedsApproval"],
    ["git -c diff.mydriver.command='rm -f /tmp/x' diff", "NeedsApproval"],
    ["git -c interactive.diffFilter=rm status", "NeedsApproval"],
    ["git -c ALIAS.X='!rm -f /tmp/x' x", "NeedsApproval"],
    ["git --config-env core.pager=EVIL log", "NeedsApproval"],
    ["git -C /tmp status", "Skip"],
    ["git --work-tree ../t status", "Skip"],
    ["git -c filter.blob.required=false status", "Skip"],
    // `kill` reporting forms do not signal; a mixed form still reviews.
    ["kill -l", "Skip"],
    ["kill -L", "Skip"],
    ["kill --version", "Skip"],
    ["kill -l -9 1", "NeedsApproval"],
    ["kill -TERM -1", "NeedsApproval"],
    // Read-only control-plane verbs must not be caught by the mutation table.
    ["aws s3 ls s3://bucket", "Skip"],
    ["aws ec2 describe-instances", "Skip"],
    ["gcloud compute instances list", "Skip"],
    ["kubectl get pods", "Skip"],
    ["helm list", "Skip"],
    ["npm ls", "Skip"],
    ["vercel --version", "Skip"],
    // A verb used as an option value is not a verb: `terraform plan -out apply`.
    ["terraform plan -out apply", "Skip"],
    ["trap 'rm -rf /tmp/x' EXIT", "Forbidden"],
    ['bash -lc "rm -rf build"', "Forbidden"],
    ['sh -c "rm -f x"', "Forbidden"],
    // `trap ACTION SIGNAL` stores shell code to run later, so the action is a
    // program the static argv never showed: unclassifiable, hence REVIEW.
    ["trap 'ls' EXIT", "NeedsApproval"],
    ["php -r 'system(\"ls\");'", "NeedsApproval"],
    ["deno eval 'console.log(1)'", "NeedsApproval"],
    ["perl -wE 'say 1'", "NeedsApproval"],
    ["php -dr 'system(\"ls\");'", "NeedsApproval"],
    // Stripping a delegating wrapper must not disturb ordinary wrapped reads.
    ["timeout 1 ls -la", "Skip"],
    ["nice -n 5 git status", "Skip"],
    // A word after a value-taking option is that option's value, and a bare `-`
    // is the stdin sentinel: the program comes from a pipe, not the argv.
    ["bash -o pipefail", "NeedsApproval"],
    ["python -X utf8", "NeedsApproval"],
    ["deno run -", "NeedsApproval"],
    // The operand behind an option's value is still read: a fixed argv.
    ["bash -o pipefail script.sh", "Skip"],
    ["php -d memory_limit=1G script.php", "Skip"],
    ["rm -r build", "Skip"],
    ["rm build/a.ts", "Skip"],
    ["rmdir build/cache", "Skip"],
    ["unlink build/a.ts", "Skip"],
    ["shred build/a.ts", "Skip"],
    ["truncate -s 0 build/a.ts", "Skip"],
    ["rm -- -f build", "Skip"],
    ["git push origin feature", "Forbidden"],
    ["do git push origin feature", "Forbidden"],
    ["curl https://example.com", "Forbidden"],
    ["npm publish", "Forbidden"],
    ["kubectl delete deployment production", "Skip"],
    ["FOO=bar cat README.md", "Skip"],
    ["cat *.md", "Skip"],
    ["cat {README,LICENSE}", "Skip"],
    ["cat #comment", "Skip"],
    ["cat (README.md)", "Skip"],
    ["cat ~/README.md", "Skip"],
    ["cat !README.md", "Skip"],
    ["cat ?README.md", "Skip"],
    ["cat [README].md", "Skip"],
    // Expansion in the *command* position rewrites which binary runs, so the
    // argv read here is not the argv that executes. `{rm,echo} -f build`
    // expands to `rm echo -f build`, and rm deletes `build` and `echo`.
    ["{rm,echo} -f build", "NeedsApproval"],
    ["r?m -f build", "NeedsApproval"],
    ["g{hc,cloud} pr merge 1", "NeedsApproval"],
    // `include.path` / `includeIf.<condition>.path` make Git parse another
    // config file, which can define `alias.<name> = !cmd` — the executable
    // entry point an inline `git -c alias.x=` already guards, one hop away.
    ["git -c include.path=/tmp/gcfg x", "NeedsApproval"],
    ["git -c includeIf.hasconfig:remote.*.path=/tmp/gcfg x", "NeedsApproval"],
    // A named module is not a script path: what runs is the module's
    // `__main__`, whose contents are not in argv.
    ["python3 -m pip install requests", "NeedsApproval"],
    ["python3 -m pytest", "NeedsApproval"],
    // The attached spelling runs the same module.
    ["python3 -mfoo main.py", "NeedsApproval"],
    // `exec` and `setsid` are delegating wrappers like `nohup`; both were
    // missing, so the nested command was never inspected. Verified by
    // execution: `exec rm -f victim` removed the file.
    ["exec rm -f /tmp/victim", "Forbidden"],
    ["setsid rm -f /tmp/victim", "Forbidden"],
    ["exec kill -9 1", "NeedsApproval"],
    // A `GIT_CONFIG_*` variable points Git at a config file this argv never
    // names, and that file can define an alias.
    ["GIT_CONFIG_GLOBAL=/tmp/gcfg git name", "NeedsApproval"],
    ["GIT_CONFIG_SYSTEM=/tmp/gcfg git name", "NeedsApproval"],
    // A global option ahead of the subcommand used to hide it: the scan read
    // the option's value as the subcommand, so `--prefix /tmp` was compared
    // against the verb table and `install` was never seen.
    ["npm --prefix /tmp install lodash", "Forbidden"],
    ["npm install lodash", "Forbidden"],
    // `[` is the one glob metacharacter that is also a real builtin.
    ["[ -f README.md ]", "Skip"],
    // zsh expands a leading `=` to the full path of the command, so `=rm` is
    // rm. Verified in a real zsh.
    ["zsh -c '=rm -f /tmp/x'", "NeedsApproval"],
    // Program-valued config keys the earlier name list did not cover. The
    // check is now an allowlist of scalar key segments, so an unlisted key is
    // unproven rather than allowed.
    ["git -c 'credential.https://x.com.helper=!echo EVIL' credential fill", "NeedsApproval"],
    ["git -c 'pager.foo.cmd=!echo EVIL' log", "NeedsApproval"],
    // `alias.<name>` has an author-chosen tail, so its last segment carries no
    // information: `alias.name` ends in a scalar name and is still a program.
    ["git -c 'alias.name=!echo EVIL' name", "NeedsApproval"],
    ["git -c 'alias.status=!echo EVIL' status", "NeedsApproval"],
    ["git config alias.name '!echo EVIL'", "NeedsApproval"],
    ["git -c 'pager.name=!echo EVIL' log", "NeedsApproval"],
    ["git -c 'color.pager=!echo EVIL' log", "NeedsApproval"],
    // Scalar keys stay allowed, including the URL-scoped and per-branch forms
    // the allowlist matches on the last segment.
    ["git -c user.name=Ada commit -m x", "Skip"],
    ["git -c core.autocrlf=false status", "Skip"],
    ["git -c init.defaultbranch=main status", "Skip"],
    ["git config --global user.name Ada", "Skip"],
    // A noun-led package manager puts its verb after `workspace <name>`.
    ["yarn workspace foo add lodash", "Forbidden"],
    // `--help` is a value here, not a terminal flag, so the invocation goes on
    // to create the pull request.
    ["gh pr create --title --help --body x", "Forbidden"],
    // The key comes after a value-taking option, so `--file`'s path must not
    // be read as the key.
    ["git config --file user.name --add core.pager '!echo EVIL'", "NeedsApproval"],
    // `--edit` opens the config in $GIT_EDITOR.
    ["git config --edit", "NeedsApproval"],
    // A terminal flag is only terminal where it cannot be a value.
    ["gh --version", "Skip"],
    // `--help` here is `--as`'s value, so the invocation reaches `delete`
    // rather than printing help. Verified against a real kubectl.

    // Same shape in the interpreter analysis: `-W` takes the value, and python
    // goes on to run the program it is handed.
    ["python3 -W --help", "NeedsApproval"],
    // An attached value cannot shift an operand, so it needs no table entry.
    ["kubectl -n=default get pods", "Skip"],
    ["git -c user.email=a@b status", "Skip"],
    ["git -c status.short=true status", "Skip"],
    ["git -c push.default=simple status", "Skip"],
    // `--version` is the value of `-O` here, so wget goes on to fetch the URL.
    // A terminal flag only ends an invocation where nothing can consume it. The
    // host is now seen, so the unapproved-network gate returns HARD rather than
    // letting the command through as LOW.
    ["wget -O --version https://evil.example/x", "Forbidden"],
    ["curl -d --help https://evil.example/x", "Forbidden"],
    // `-C` is noclobber and takes no value; it is not `-c`. Matching the
    // option case-insensitively resolved the program to the literal `-c` and
    // left `rm -rf build` unexamined.
    ["bash -C -c 'rm -rf build'", "Forbidden"],
    ["sh -C -c 'rm -rf build'", "Forbidden"],
    // A redirection operator is its own token wherever it appears unquoted.
    // Reading it as word text made the executable `rm>log`, which is in no
    // executable table, and the forced-deletion gate never ran.
    ["rm>log -f build", "Forbidden"],
    ["rm 2>log -f build", "Forbidden"],
    // The subcommand search steps over the redirection instead of stopping on
    // it, so this is recognised as the network push it is.
    ["git push>log origin main", "Forbidden"],
    ["git -- 2>log push origin main", "Forbidden"],
    // A bare operator's target is a filename. `git > push origin main` writes to
    // a file called `push` and then runs `git origin main`; the word `push` is
    // not a subcommand, so this is not the network operation it resembles.
    ["git > push origin main", "Skip"],
    // The terminal flag is terminal wherever it lands in the effective argv.
    // The redirect is syntax, not an argument, so it does not displace it.
    ["curl 2>/dev/null --version", "Skip"],
    ["curl >out --help", "Skip"],
    // A quoted redirect target is a target, not a bare operator followed by an
    // argument. Quotes are stripped before words are tested, so `>'>'` has the
    // shape of the `>>` operator; re-matching the pattern here swallowed the
    // next real argument and made these LOW.
    ["rm >'>' -rf /", "Forbidden"],
    ["rm >'|' -rf /", "Forbidden"],
    ["rm >\\> -rf /", "Forbidden"],
    // A quoted operand that starts with a redirect character is an ordinary
    // argument. `python '>out' script.py` runs the file `>out` with
    // `script.py` as argv[1], so the program is named and the invocation is
    // LOW; treating the quoted `>` as a redirect would find no script at all.
    ["python3 '>out' script.py", "Skip"],
    // A single quote is literal inside double quotes. Treating it as opening a
    // single-quoted region swallowed the rest of the input, so the substitution
    // gate behind it reported nothing and this auto-approved LOW.
    ['echo "it\'s" `rm -rf /`', "NeedsApproval"],
    ['echo "a\'b" `rm -rf /`', "NeedsApproval"],
    // The mirror case was already right: a double quote is literal inside single
    // quotes, and both substitution forms stay live inside double quotes. The
    // nested `rm -rf /` is analysed as a forced deletion, so these are HARD.
    ['echo "x" $(rm -rf /)', "Forbidden"],
    ["echo 'x' $(rm -rf /)", "Forbidden"],
    // A bare package manager has no verb to find, and may run install or
    // lifecycle actions anyway. `some` over an empty operand list read as "no
    // mutation" and auto-approved it.
    ["npm", "NeedsApproval"],
    ["pnpm", "NeedsApproval"],
    // `env -C DIR` moves the working directory, so operands resolve against a
    // root the request never named. The reference implementation sends the whole
    // `env` invocation to review rather than parsing the option.
    ["env -C /tmp git add README.md", "NeedsApproval"],
    ["env --chdir=/tmp git add README.md", "NeedsApproval"],
    // State published in one segment and read in another is not analysable
    // segment by segment; the editor program is named by the environment.
    ["export GIT_EDITOR='rm -f x'; git commit", "NeedsApproval"],
    // A single assignment, or one scoped to a child process, is still provable.
    ["FOO=1 printenv FOO", "Skip"],
    ["env FOO=1 printenv FOO", "Skip"],
    ["git status; git log", "Skip"],
  ] as const)("classifies sandboxed Bash %s as %s", (command, expected) => {
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe(expected);
  });

  it.each(['echo "$(rm -rf build)"', "echo `rm -rf build`"])(
    "requires review for executable shell substitution in %s",
    (command) => {
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe(
        "NeedsApproval",
      );
    },
  );

  it("classifies wrapper option parsing without catastrophic backtracking", () => {
    // A nested-quantifier regex on the `stdbuf` attached-value form made a
    // 25-character token take seconds. Commands are agent-authored, so this
    // input is reachable and must stay cheap.
    for (const length of [20, 25, 40, 80]) {
      const command = `stdbuf -o${"a".repeat(length)}! rm -rf build`;
      const started = performance.now();
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe(
        "NeedsApproval",
      );
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it.each([
    "printf '%s\\n' '$(rm -rf build)'",
    "printf '%s\\n' '`rm -rf build`'",
    "printf '%s\\n' \\$HOME",
  ])("keeps inert shell substitution syntax low risk in %s", (command) => {
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo"))).toBe("Skip");
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
