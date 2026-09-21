import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fingerprintConfig, type SafetyConfig } from "./config.ts";
import { isRecord } from "./unknown-value.ts";

export type PermissionMode = "auto" | "yolo";

/** Modes persisted by older versions; they restore as "auto". */
const legacyModes = new Set<string>(["default", "plan"]);

export interface PermissionSessionState {
  mode: PermissionMode;
  auto: { consecutiveDenials: number; paused: boolean };
  sandboxProfile: "workspace-write" | "read-only";
  configFingerprint: string;
}

type StateEntry = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "auto" || value === "yolo";
}

function isSessionState(value: unknown): value is PermissionSessionState {
  if (!isRecord(value)) return false;
  // Accept legacy modes here so reducePermissionEntries can coerce them.
  if (
    typeof value.mode !== "string" ||
    (!isPermissionMode(value.mode) && !legacyModes.has(value.mode))
  ) {
    return false;
  }
  const auto = value.auto;
  if (!isRecord(auto)) return false;
  return (
    typeof auto.consecutiveDenials === "number" &&
    Number.isSafeInteger(auto.consecutiveDenials) &&
    auto.consecutiveDenials >= 0 &&
    typeof auto.paused === "boolean" &&
    (value.sandboxProfile === "workspace-write" || value.sandboxProfile === "read-only") &&
    typeof value.configFingerprint === "string"
  );
}

export function createPermissionSessionState(config: SafetyConfig): PermissionSessionState {
  return {
    mode: "auto",
    auto: { consecutiveDenials: 0, paused: false },
    sandboxProfile: config.sandbox.profile,
    configFingerprint: fingerprintConfig(config),
  };
}

export function persistPermissionState(
  pi: Pick<ExtensionAPI, "appendEntry">,
  state: PermissionSessionState,
): void {
  pi.appendEntry("pi-safety-state", state);
}

export function reducePermissionEntries(
  entries: readonly unknown[],
  defaults: SafetyConfig,
  reportMalformed: (entry: unknown) => void = () => {},
): PermissionSessionState {
  let state = createPermissionSessionState(defaults);
  for (const entry of entries) {
    const candidate = entry as StateEntry;
    if (candidate?.type !== "custom" || candidate.customType !== "pi-safety-state") continue;
    if (!isSessionState(candidate.data)) {
      reportMalformed(entry);
      continue;
    }
    state = structuredClone(candidate.data);
    if (!isPermissionMode(state.mode)) state.mode = "auto"; // legacy default/plan -> auto
  }
  return state;
}

export function restorePermissionState(
  entries: readonly unknown[],
  config: SafetyConfig,
  reportMalformed: (entry: unknown) => void = () => {},
): PermissionSessionState {
  const restored = reducePermissionEntries(entries, config, reportMalformed);
  return restored.configFingerprint === fingerprintConfig(config)
    ? restored
    : createPermissionSessionState(config);
}
