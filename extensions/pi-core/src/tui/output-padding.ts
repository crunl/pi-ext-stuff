import { readFileSync, type Stats, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isInteractiveTui } from "./ui-guard.ts";

export type OutputPad = 0 | 1;

export interface OutputPaddingSource {
  getOutputPad(): OutputPad;
  track(toolCallId: string, invalidate: () => void): void;
}

interface OutputPadSetting {
  found: boolean;
  value?: unknown;
}

/** Upper bound on retained per-tool-call invalidate callbacks. */
const MAX_TRACKED_INVALIDATORS = 200;
/** Settings are human-edited; sub-second polling avoids needless background stat churn. */
const SETTINGS_POLL_INTERVAL_MS = 500;

function readOutputPad(settingsPath: string): OutputPadSetting {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (typeof settings === "object" && settings !== null && Object.hasOwn(settings, "outputPad")) {
      return {
        found: true,
        value: (settings as { outputPad: unknown }).outputPad,
      };
    }
  } catch {
    // Pi treats missing or invalid settings files as an empty scope.
  }
  return { found: false };
}

export class OutputPaddingController implements OutputPaddingSource {
  private outputPad: OutputPad = 1;
  private projectSettingsPath: string | undefined;
  private readonly invalidators = new Map<string, () => void>();
  private readonly watchedPaths = new Map<string, (current: Stats, previous: Stats) => void>();

  constructor(private readonly agentDir: string) {}

  private get globalSettingsPath(): string {
    return join(this.agentDir, "settings.json");
  }

  start(cwd: string, projectTrusted: boolean): void {
    this.stop();
    this.projectSettingsPath = projectTrusted
      ? join(cwd, CONFIG_DIR_NAME, "settings.json")
      : undefined;
    this.outputPad = this.readEffectiveOutputPad();

    this.watch(this.globalSettingsPath);
    if (this.projectSettingsPath) {
      this.watch(this.projectSettingsPath);
    }
  }

  stop(): void {
    for (const [settingsPath, listener] of this.watchedPaths) {
      unwatchFile(settingsPath, listener);
    }
    this.watchedPaths.clear();
    this.invalidators.clear();
    this.projectSettingsPath = undefined;
  }

  refresh(): void {
    const nextOutputPad = this.readEffectiveOutputPad();
    if (nextOutputPad === this.outputPad) return;

    this.outputPad = nextOutputPad;
    for (const [toolCallId, invalidate] of this.invalidators) {
      try {
        invalidate();
      } catch {
        this.invalidators.delete(toolCallId);
      }
    }
  }

  getOutputPad(): OutputPad {
    return this.outputPad;
  }

  track(toolCallId: string, invalidate: () => void): void {
    // Cap retained invalidators: entries for finished tool calls are only
    // dropped when they throw during refresh(), so a long session would
    // otherwise accumulate one closure per tool call. Rendered tool calls
    // re-track on every render, so trimming the oldest entries is safe —
    // anything still on screen re-registers immediately.
    if (!this.invalidators.has(toolCallId) && this.invalidators.size >= MAX_TRACKED_INVALIDATORS) {
      const oldest = this.invalidators.keys().next().value;
      if (oldest !== undefined) this.invalidators.delete(oldest);
    }
    this.invalidators.set(toolCallId, invalidate);
  }

  private readEffectiveOutputPad(): OutputPad {
    const globalSetting = readOutputPad(this.globalSettingsPath);
    const projectSetting = this.projectSettingsPath
      ? readOutputPad(this.projectSettingsPath)
      : { found: false };
    const effectiveOutputPad = projectSetting.found ? projectSetting.value : globalSetting.value;
    return effectiveOutputPad === 0 ? 0 : 1;
  }

  private watch(settingsPath: string): void {
    const listener = (_current: Stats, _previous: Stats) => this.refresh();
    watchFile(settingsPath, { interval: SETTINGS_POLL_INTERVAL_MS, persistent: false }, listener);
    this.watchedPaths.set(settingsPath, listener);
  }
}

/**
 * Cross-jiti singleton. Pi loads extensions with isolated module caches, while
 * pi-permissions imports createCodexToolRendering from standalone.ts. Both
 * copies must observe the controller started by pi-core's register graph.
 */
const OUTPUT_PADDING_CONTROLLER_KEY = Symbol.for("@x1a2h1/pi-core:output-padding-controller");
const sharedControllers = globalThis as Record<symbol, OutputPaddingController | undefined>;

function getSharedOutputPaddingController(): OutputPaddingController {
  const existing = sharedControllers[OUTPUT_PADDING_CONTROLLER_KEY];
  if (existing) return existing;
  const created = new OutputPaddingController(getAgentDir());
  sharedControllers[OUTPUT_PADDING_CONTROLLER_KEY] = created;
  return created;
}

export const outputPaddingController = getSharedOutputPaddingController();

export function registerOutputPaddingSync(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => {
    if (!isInteractiveTui(context)) {
      outputPaddingController.stop();
      return;
    }
    outputPaddingController.start(context.cwd, context.isProjectTrusted());
  });
  pi.on("session_shutdown", () => {
    outputPaddingController.stop();
  });
}
