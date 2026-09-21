#!/usr/bin/env node
/**
 * Real-host turn-boundary check for pi-permissions.
 *
 * Loads the extension through @earendil-works/pi-coding-agent's
 * createAgentSession + bindExtensions (print mode), then drives
 * agent_start → Shift+Tab → turn_start via the session's ExtensionRunner
 * so the step-boundary contract is asserted against a live ExtensionContext.
 *
 * Offline: no LLM, no network, stub SRT manager.
 *
 * Expected SRT ops for auto → yolo:
 *   activate                      (session_start / auto; manager exposes activate)
 *   (cycle: no SRT op)
 *   reset                         (next turn_start applies yolo)
 *
 * Expected SRT ops for auto → yolo → auto:
 *   …reset, then activate on the turn_start that restores auto (yolo had no live SRT).
 *
 * Invocation: npm run check:host-turn-boundary
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hostPkg = join(
  repoRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "index.js",
);
const registerTs = join(repoRoot, "src", "register.ts");
const jitiEntry = join(repoRoot, "node_modules", "jiti", "lib", "jiti.mjs");

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
  pathToFileURL(hostPkg).href
);
const { createJiti } = await import(pathToFileURL(jitiEntry).href);

const failures = [];
function log(line) {
  process.stderr.write(`${line}\n`);
}
function check(name, cond, detail) {
  if (cond) {
    log(`ok  ${name}`);
  } else {
    failures.push(name);
    log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function createRecordingSandboxManager(trace) {
  return {
    async initialize(config) {
      trace.push("initialize");
      return { ok: true, allowWrite: config?.filesystem?.allowWrite ?? [] };
    },
    async activate() {
      trace.push("activate");
    },
    async reset() {
      trace.push("reset");
    },
    isHealthy: () => true,
    async execute(request) {
      trace.push(
        `execute:${[request.program.executable, ...(request.program.args ?? [])].join(" ")}`.slice(
          0,
          80,
        ),
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-host-turn-boundary-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  // Free Shift+Tab: an explicit empty binding means "not reserved".
  await writeFile(
    join(agentDir, "keybindings.json"),
    JSON.stringify({ "app.thinking.cycle": [] }, null, 2),
  );
  await writeFile(join(agentDir, "settings.json"), "{}");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const trace = [];
  const jiti = createJiti(pathToFileURL(join(repoRoot, "scripts/host-turn-boundary.mjs")).href);
  const { registerExtension } = await jiti.import(registerTs);

  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        registerExtension(pi, {
          agentDir,
          sandboxManager: createRecordingSandboxManager(trace),
        });
      },
    ],
  });
  await resourceLoader.reload();

  const { session, extensionsResult } = await createAgentSession({
    cwd: workspace,
    agentDir,
    resourceLoader,
    sessionManager: SessionManager.inMemory(workspace),
    settingsManager: SettingsManager.create(workspace, agentDir),
    tools: ["bash"],
  });

  // SDK createAgentSession does not call bindExtensions; print mode does.
  await session.bindExtensions({
    mode: "print",
    onError: (err) => {
      failures.push(`extension_error:${err?.error}`);
      log(`extension_error ${String(err?.error)}`);
    },
  });

  const extensions = extensionsResult?.extensions ?? resourceLoader.getExtensions?.() ?? [];
  check("extensions_loaded", extensions.length > 0, `count=${extensions.length}`);

  let cycleHandler;
  for (const ext of extensions) {
    const handler = ext.shortcuts?.get?.("shift+tab")?.handler;
    if (typeof handler === "function") {
      cycleHandler = handler;
      break;
    }
  }
  check("shift_tab_handler_registered", typeof cycleHandler === "function");

  const postBind = [...trace];
  // When the manager exposes activate(), register.ts prefers it over initialize.
  check("session_start_activates_auto", postBind.includes("activate"), JSON.stringify(postBind));

  const runner = session.extensionRunner;
  check("extension_runner_available", Boolean(runner?.createContext && runner?.emit));

  const ctx = runner.createContext();
  const baseline = trace.length;

  // Open a live turn, cycle mid-turn, then apply at the next step boundary.
  await runner.emit({ type: "agent_start" });
  await cycleHandler(ctx);
  const afterCycle = trace.slice(baseline);
  check(
    "midturn_cycle_does_not_touch_srt",
    !afterCycle.some((op) => op === "activate" || op === "reset" || op.startsWith("execute:")),
    JSON.stringify(afterCycle),
  );

  await runner.emit({ type: "turn_start", turnIndex: 1, timestamp: Date.now() });
  const afterBoundary = trace.slice(baseline);
  check(
    "turn_start_applies_yolo_via_reset",
    afterBoundary.includes("reset") && !afterBoundary.filter((op) => op === "activate").length,
    JSON.stringify(afterBoundary),
  );

  // Restore auto at the next step boundary: cycle again, then turn_start.
  const mid = trace.length;
  await cycleHandler(ctx);
  await runner.emit({ type: "turn_start", turnIndex: 2, timestamp: Date.now() });
  const restore = trace.slice(mid);
  // yolo has no live SRT, so restoring auto installs via activate (no prior reset).
  check(
    "second_boundary_restores_auto_via_activate",
    restore.includes("activate"),
    JSON.stringify(restore),
  );

  try {
    session.dispose();
  } catch {
    // best effort
  }

  if (failures.length) {
    log(`host-turn-boundary FAILED ${JSON.stringify(failures)}`);
    process.exitCode = 1;
  } else {
    log(`host-turn-boundary OK ${JSON.stringify({ ops: trace })}`);
  }
}

try {
  await main();
} catch (error) {
  log(`host-turn-boundary ERROR ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
}
