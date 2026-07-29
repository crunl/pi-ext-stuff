# Plugin-Local Global Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load the global `pi-permissions` configuration exclusively from `~/.pi/agent/extensions/pi-permissions/config.json`.

**Architecture:** Keep `agentDir` as the loader's stable root and derive the plugin-local global path beneath it. Preserve the existing built-in-default → global → trusted-project merge pipeline and all non-escalation restrictions.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, Pi 0.82.1 extension APIs.

## Global Constraints

- The global configuration path is `<agentDir>/extensions/pi-permissions/config.json`.
- The trusted project configuration path remains `<cwd>/.pi/permissions.json`.
- The old `<agentDir>/permissions.json` path is ignored without migration.
- `/config.json` is untracked; `config.example.json` is tracked and schema-valid.
- Configuration fields and merge semantics do not change.
- Do not use a worktree.

---

### Task 1: Change the global configuration path

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `loadPermissionsConfig(cwd: string, agentDir: string, projectTrusted: boolean)`.
- Produces: global configuration loaded from `join(agentDir, "extensions", "pi-permissions", "config.json")`.

- [ ] **Step 1: Add failing path tests**

Add a fixture helper:

```ts
function globalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", "pi-permissions", "config.json");
}
```

Add tests proving:

```ts
it("loads global configuration from the plugin directory", async () => {
  await withConfigRoots(async ({ agentDir, cwd }) => {
    await writeJson(globalConfigPath(agentDir), {
      sandbox: { profile: "read-only" },
    });
    const loaded = await loadPermissionsConfig(cwd, agentDir, false);
    expect(loaded.globalConfig.sandbox.profile).toBe("read-only");
  });
});

it("ignores the legacy agent-level permissions file", async () => {
  await withConfigRoots(async ({ agentDir, cwd }) => {
    await writeJson(join(agentDir, "permissions.json"), {
      sandbox: { profile: "read-only" },
    });
    const loaded = await loadPermissionsConfig(cwd, agentDir, false);
    expect(loaded.globalConfig.sandbox.profile).toBe("workspace-write");
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: the plugin-directory test fails because the loader still reads the
legacy path.

- [ ] **Step 3: Implement the new path**

Change:

```ts
const globalPath = join(agentDir, "permissions.json");
```

to:

```ts
const globalPath = join(
  agentDir,
  "extensions",
  "pi-permissions",
  "config.json",
);
```

- [ ] **Step 4: Migrate existing test fixtures**

Replace global fixture writes such as:

```ts
writeJson(join(agentDir, "permissions.json"), value)
```

with:

```ts
writeJson(globalConfigPath(agentDir), value)
```

The legacy-path test remains the only test writing the old path.

- [ ] **Step 5: Run config tests and verify GREEN**

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: all configuration tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: load global config from plugin directory"
```

---

### Task 2: Add local configuration hygiene and example

**Files:**
- Modify: `.gitignore`
- Create: `config.example.json`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `validatePermissionsConfig(input: unknown)`.
- Produces: a complete tracked example accepted by the current schema and an ignored machine-local `config.json`.

- [ ] **Step 1: Add the example-validation test**

Import `readFile` and add:

```ts
it("ships a schema-valid complete example config", async () => {
  const contents = await readFile(
    join(import.meta.dirname, "..", "config.example.json"),
    "utf8",
  );
  expect(() => validatePermissionsConfig(JSON.parse(contents))).not.toThrow();
});
```

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: FAIL with `ENOENT` because `config.example.json` does not exist.

- [ ] **Step 2: Add `/config.json` to `.gitignore`**

Append:

```gitignore
/config.json
```

- [ ] **Step 3: Create the complete example**

Create `config.example.json` containing every supported field with safe defaults:

```json
{
  "version": 1,
  "defaultMode": "default",
  "reviewer": {
    "provider": "openai-codex",
    "model": "gpt-5.6",
    "reasoningEffort": "high",
    "timeoutMs": 60000,
    "maxConsecutiveDenials": 3
  },
  "sandbox": {
    "enabled": true,
    "profile": "workspace-write",
    "filesystem": {
      "allowWrite": [".", "/tmp"],
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", ".env", ".env.*", "*.pem", "*.key"],
      "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
    },
    "network": {
      "allowedDomains": [],
      "deniedDomains": ["localhost", "127.0.0.1", "::1", "169.254.169.254"]
    }
  },
  "rules": []
}
```

- [ ] **Step 4: Verify GREEN and ignore behavior**

Run:

```bash
npx vitest run tests/config.test.ts
git check-ignore config.json
```

Expected: tests pass and `git check-ignore` prints `config.json`.

- [ ] **Step 5: Commit**

```bash
git add .gitignore config.example.json tests/config.test.ts
git commit -m "docs: add local permissions config example"
```

---

### Task 3: Full verification and review

**Files:**
- Review: `src/config.ts`
- Review: `tests/config.test.ts`
- Review: `.gitignore`
- Review: `config.example.json`

**Interfaces:**
- Consumes: the completed loader and configuration artifacts.
- Produces: verified, committed behavior with no legacy-path fallback.

- [ ] **Step 1: Search for stale global-path references**

Run:

```bash
rg -n 'agentDir, "permissions\\.json"|agent/permissions\\.json' src tests docs config.example.json
```

Expected: no production reference; only deliberate historical/spec or legacy-test references may remain.

- [ ] **Step 2: Run complete verification**

Run:

```bash
npm test
npm run check
git diff --check
git status --short
```

Expected: all tests pass, TypeScript reports no errors, and the worktree is clean after commits.

- [ ] **Step 3: Review security invariants**

Confirm:

- Untrusted projects receive only global configuration.
- Project reviewer replacement remains ignored.
- Project Auto escalation remains blocked.
- Project write roots and network domains remain intersections of global allowances.
- Project deny lists and deny rules remain additive.
- Invalid global `config.json` reports its exact plugin-local path and fails closed.
