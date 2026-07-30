import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fingerprintConfig, type PermissionsConfig } from "./config.ts";

export type PermissionMode = "default" | "plan" | "auto" | "yolo";

export interface PermissionSessionState {
  mode: PermissionMode;
  modeBeforePlan?: Exclude<PermissionMode, "plan">;
  plan?: { markdown: string; status: "draft" | "approved" | "revising" };
  auto: { consecutiveDenials: number; paused: boolean };
  sandboxProfile: "workspace-write" | "read-only";
  configFingerprint: string;
}

type StateEntry = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

const modes = new Set<PermissionMode>(["default", "plan", "auto", "yolo"]);
const planStatuses = new Set<NonNullable<PermissionSessionState["plan"]>["status"]>([
  "draft",
  "approved",
  "revising",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && modes.has(value as PermissionMode);
}

function isSessionState(value: unknown): value is PermissionSessionState {
  if (!isRecord(value) || !isMode(value.mode) || !isRecord(value.auto)) return false;
  const auto = value.auto;
  if (
    typeof auto.consecutiveDenials !== "number" ||
    !Number.isSafeInteger(auto.consecutiveDenials) ||
    auto.consecutiveDenials < 0 ||
    typeof auto.paused !== "boolean" ||
    (value.sandboxProfile !== "workspace-write" && value.sandboxProfile !== "read-only") ||
    typeof value.configFingerprint !== "string"
  ) {
    return false;
  }
  if (
    value.modeBeforePlan !== undefined &&
    value.modeBeforePlan !== "default" &&
    value.modeBeforePlan !== "auto" &&
    value.modeBeforePlan !== "yolo"
  ) {
    return false;
  }
  if (value.plan !== undefined) {
    if (
      !isRecord(value.plan) ||
      typeof value.plan.markdown !== "string" ||
      !planStatuses.has(value.plan.status as NonNullable<PermissionSessionState["plan"]>["status"])
    ) {
      return false;
    }
  }
  return true;
}

export function createPermissionSessionState(config: PermissionsConfig): PermissionSessionState {
  return {
    mode: config.defaultMode,
    auto: { consecutiveDenials: 0, paused: false },
    sandboxProfile: config.sandbox.profile,
    configFingerprint: fingerprintConfig(config),
  };
}

export function persistPermissionState(
  pi: Pick<ExtensionAPI, "appendEntry">,
  state: PermissionSessionState,
): void {
  pi.appendEntry("pi-permissions-state", state);
}

export function reducePermissionEntries(
  entries: readonly unknown[],
  defaults: PermissionsConfig,
  reportMalformed: (entry: unknown) => void = () => {},
): PermissionSessionState {
  let state = createPermissionSessionState(defaults);
  for (const entry of entries) {
    const candidate = entry as StateEntry;
    if (candidate?.type !== "custom" || candidate.customType !== "pi-permissions-state") continue;
    if (!isSessionState(candidate.data)) {
      reportMalformed(entry);
      continue;
    }
    state = structuredClone(candidate.data);
  }
  return state;
}

export function restorePermissionState(
  entries: readonly unknown[],
  config: PermissionsConfig,
  reportMalformed: (entry: unknown) => void = () => {},
): PermissionSessionState {
  const restored = reducePermissionEntries(entries, config, reportMalformed);
  return restored.configFingerprint === fingerprintConfig(config)
    ? restored
    : createPermissionSessionState(config);
}
