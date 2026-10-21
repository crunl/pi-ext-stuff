/**
 * The three state lifetimes `registerExtension` composes.
 *
 * `registerExtension` is one registration-scoped function, but the state it
 * holds does not share that single lifetime: it is three clusters, each with its
 * own invariant and its own moment of discard. Because a closure `let` has
 * exactly one lifetime — its enclosing call — each cluster gets a factory here
 * whose interface states which lifetime it owns. `registerExtension` then only
 * instantiates the three and wires them to the host seam.
 *
 * These factories own state, never behaviour toward the host: no `pi.*` call, no
 * tool preparation, no presentation. The host adapter stays in `register.ts`; the
 * invariants live here.
 */
import type { LoadedSafetyConfig, SafetyConfig } from "./config.ts";
import type { PermissionModeRuntime } from "./mode-runtime.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";
import type { PermissionMode } from "./state.ts";

/** The sandbox profile an activation committed, or why there is none. */
export type SandboxState =
  | { kind: "pending" }
  | { kind: "disabled" }
  | { kind: "ready"; profile: SafetyConfig["sandbox"]["profile"] }
  | { kind: "failed"; error: string };

/**
 * The config facts one successful activation installs: the config, the cache
 * key it was read under, and the policy the backend was activated with.
 *
 * The sandbox state is deliberately NOT part of it. It describes the backend,
 * not the config, and it is published beside the record by the same call that
 * publishes the record. Carrying a copy inside the record gave that one fact
 * two homes, so a rollback that reported how the attempt actually left the
 * backend could only update one of them — and every reader of the copy saw a
 * readiness that the backend no longer had.
 */
export interface ActivationRecord {
  readonly loaded: LoadedSafetyConfig;
  readonly key: string;
  readonly baseSandboxConfig: SandboxPolicy | undefined;
}

export interface ReloadScopedState {
  /**
   * The live activation, or undefined before the first successful one. Reading a
   * config from disk never publishes it: only `commit` does, so no reader can
   * observe a config the sandbox was not activated for.
   */
  activation(): ActivationRecord | undefined;
  /** True when `key` is already the live activation. */
  isLive(key: string): boolean;
  /** The live activation when it was read under `key`, otherwise undefined. */
  liveFor(key: string): ActivationRecord | undefined;
  /** The config read error of this registration; rethrown on every cache read. */
  configFailure(): Error | undefined;
  recordConfigFailure(error: Error): void;
  /** The failure latched for `key`, if a prior activation under it failed. */
  activationFailure(key: string): Error | undefined;
  /** The mode runtime, or undefined before the first one is installed. */
  modeRuntime(): PermissionModeRuntime | undefined;
  /** The installed policy, for readers that render or re-project it. */
  baseSandboxConfig(): SandboxPolicy | undefined;
  /** The installed sandbox state, for readiness and status. */
  sandboxState(): SandboxState;

  /**
   * Publish one activation atomically and clear both failure latches: the
   * record and the backend state it installed move together, never as
   * independent writes.
   */
  commit(record: ActivationRecord, sandboxState: SandboxState): void;
  /**
   * Replace the sandbox pair while keeping the live config: the backend moved
   * to `disabled` or `failed` underneath an unchanged config.
   */
  publishSandbox(sandboxState: SandboxState, baseSandboxConfig: SandboxPolicy | undefined): void;
  /**
   * Undo a failed activation: restore the previous record exactly, or — when
   * there was none — latch the failure for that key and leave no config live.
   * The sandbox state still records how the attempt left the backend, so the
   * failure notice can say whether the previous sandbox survived.
   */
  rollback(
    previous: ActivationRecord | undefined,
    key: string,
    error: Error,
    sandboxState: SandboxState,
  ): void;
  /** Install the mode runtime on first use, then hand back the same instance. */
  ensureModeRuntime(create: () => PermissionModeRuntime): PermissionModeRuntime;
  /** Replace the mode runtime wholesale (session restore, config reload). */
  installModeRuntime(runtime: PermissionModeRuntime): void;
}

/**
 * Factory for the reload-scoped lifetime: the live activation.
 *
 * Invariant: at most one committed activation, and it is only ever replaced as a
 * whole. The config, its cache key and the policy the backend was activated
 * with are three views of one fact, so they move through `commit`,
 * `publishSandbox` and `rollback` — never as independent writes. The sandbox
 * state is a fourth fact with its own home here (it also has to describe an
 * activation that never happened), so `commit` publishes it in the same call
 * rather than parking a copy inside the record. The two failure latches are
 * separate because they answer different questions:
 * `configFailure` refuses every read under this registration (the config could
 * not be parsed at all), while `activationFailure` refuses only the key whose
 * initial activation failed, so a fixed config still gets a fresh attempt.
 *
 * Lifetime: from the first activation to the end of the registration. A reload
 * replaces the record; it does not clear a latch on its own.
 */
export function createReloadScopedState(): ReloadScopedState {
  let record: ActivationRecord | undefined;
  let configFailure: Error | undefined;
  let activationFailure: { key: string; error: Error } | undefined;
  let modeRuntime: PermissionModeRuntime | undefined;
  // The backend's state, and the only home for it. It lives beside the record
  // rather than inside it: a failed first activation has no record to hang the
  // state on, a rollback that could not restore the previous sandbox must still
  // report that failure, and a copy inside the record could only ever go stale.
  let sandboxState: SandboxState = { kind: "pending" };
  let baseSandboxConfig: SandboxPolicy | undefined;

  return {
    activation: () => record,
    isLive: (key) => record !== undefined && record.key === key,
    liveFor: (key) => (record !== undefined && record.key === key ? record : undefined),
    configFailure: () => configFailure,
    recordConfigFailure: (error) => {
      configFailure = error;
    },
    activationFailure: (key) =>
      activationFailure?.key === key ? activationFailure.error : undefined,
    modeRuntime: () => modeRuntime,
    baseSandboxConfig: () => baseSandboxConfig,
    sandboxState: () => sandboxState,
    commit: (next, nextSandboxState) => {
      record = next;
      sandboxState = nextSandboxState;
      baseSandboxConfig = next.baseSandboxConfig;
      configFailure = undefined;
      activationFailure = undefined;
    },
    publishSandbox: (next, nextBaseSandboxConfig) => {
      sandboxState = next;
      baseSandboxConfig = nextBaseSandboxConfig;
      if (record !== undefined) {
        record = { ...record, baseSandboxConfig: nextBaseSandboxConfig };
      }
    },
    rollback: (previous, key, error, nextSandboxState) => {
      record = previous;
      sandboxState = nextSandboxState;
      baseSandboxConfig = previous?.baseSandboxConfig;
      if (previous === undefined) activationFailure = { key, error };
    },
    ensureModeRuntime: (create) => {
      modeRuntime ??= create();
      return modeRuntime;
    },
    installModeRuntime: (runtime) => {
      modeRuntime = runtime;
    },
  };
}

export interface TurnScopedState {
  /** Record a mid-turn cycle: the flag and the desired mode, together. */
  request(mode: PermissionMode): void;
  /** Drop an outstanding request, flag and value together. */
  clear(): void;
  /**
   * The agent_start alignment: the host is discarding the turn this request
   * belonged to, so the request is dropped without being applied. Only the flag
   * is cleared; the value left behind is unreachable because `pending()` gates
   * every read.
   */
  alignAtAgentStart(): void;
  /** True when a refresh is outstanding. Every read path gates on this flag. */
  pending(): boolean;
  /** The mode to show as pending, or undefined when nothing is owed to the user. */
  pendingAgainst(appliedMode: PermissionMode | undefined): PermissionMode | undefined;
}

/**
 * Factory for the turn-scoped lifetime: the deferred mode refresh.
 *
 * Invariant: `pendingModeRefresh` (the flag) and `pendingMode` (the value) are
 * one request and therefore clear together. The single documented exception is
 * `alignAtAgentStart`, which clears the flag only — the host is about to mint a
 * new turn, so the outstanding request cannot apply, and the stale value is
 * masked by the flag at every read. Keeping the pair *and* its one exception
 * inside this factory is the depth being bought: a caller can say "applied",
 * "dropped" or "aligned" but cannot clear half a request by accident.
 *
 * Lifetime: one host turn. The request never outlives the turn it was made in,
 * so it is settled or aligned before the next snapshot is minted.
 */
export function createTurnScopedState(): TurnScopedState {
  let flag = false;
  let value: PermissionMode | undefined;

  return {
    request: (mode) => {
      flag = true;
      value = mode;
    },
    clear: () => {
      flag = false;
      value = undefined;
    },
    alignAtAgentStart: () => {
      // Flag only, on purpose: see the interface doc above.
      flag = false;
    },
    pending: () => flag,
    pendingAgainst: (appliedMode) =>
      flag && value !== undefined && value !== appliedMode ? value : undefined,
  };
}

export interface RegistrationScopedState {
  /**
   * True the first time it is called. The caller reports the failure on
   * whichever context learns of it first, and never twice.
   */
  claimShellParserFailureNotice(): boolean;
  /** True the first time this key is seen: the caller shows the notice. */
  claimGuardianFallbackNotice(key: string): boolean;
}

/**
 * Factory for the registration-scoped lifetime: the once-per-registration
 * notices.
 *
 * Invariant: each notice is shown at most once for as long as this registration
 * lives, and no longer. `guardianFallbackNoticeKeys` must NOT be module-scoped: a
 * module-level set would survive an extension reload and silently swallow the
 * "configured reviewer unavailable" notice on the next load. Claiming and
 * remembering are one operation, so a caller cannot check the key and forget to
 * record it.
 *
 * Lifetime: from this registration to the next reload. Everything here dies with
 * the closure `registerExtension` produced.
 */
export function createRegistrationScopedState(): RegistrationScopedState {
  let shellParserFailureReported = false;
  const guardianFallbackNoticeKeys = new Set<string>();

  return {
    claimShellParserFailureNotice: () => {
      if (shellParserFailureReported) return false;
      shellParserFailureReported = true;
      return true;
    },
    claimGuardianFallbackNotice: (key) => {
      if (guardianFallbackNoticeKeys.has(key)) return false;
      guardianFallbackNoticeKeys.add(key);
      return true;
    },
  };
}
