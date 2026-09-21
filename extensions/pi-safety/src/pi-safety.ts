import { resolve } from "node:path";

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type ApproveForMeEngine,
  type AutoState,
  createApproveForMeEngine,
  type DenialNotice,
  type AdmissionPlan as EngineAdmissionPlan,
  type CapabilityAuthorizationDecision as EngineCapabilityAuthorizationDecision,
  type CapabilityAuthorizationInput as EngineCapabilityAuthorizationInput,
  type CapabilityRejectionInput as EngineCapabilityRejectionInput,
  type CapabilityRequestInput as EngineCapabilityRequestInput,
  type ExecutionAttempt as EngineExecutionAttempt,
  type PermissionAmendment as EnginePermissionAmendment,
  type RuntimeOutcome as EngineRuntimeOutcome,
  type ExecutionOutcome,
  type GuardianAdapter,
  type Invocation,
  type InvocationOwnership,
  type NativeActionFailure,
  type PermissionError,
  type PermissionPolicy,
  type PermissionStateView,
  type ReviewEvent,
  type RuntimeDenialPolicy,
  type TurnHandle,
} from "./approve-for-me-engine.ts";
import { ensureNonEmptyResiduals } from "./permissions/residual.ts";
import { admissionPlanFromRiskDecision } from "./pi-approve-for-me-adapters.ts";
import type { ReviewUi } from "./review-presenter.ts";
import { ReviewPresenter, type ReviewStatusBinding } from "./review-presenter.ts";
import type { RiskDecision } from "./risk-policy.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

/**
 * Pi's ingress vocabulary. The Engine remains an implementation detail of
 * this module; register.ts only deals in actions and execution contexts.
 */
export type PiActionKind = "sandbox" | "host" | "permission-amendment";

export type PiCapabilityRequest = EngineCapabilityRequestInput;

export interface PiPermissionRequest {
  reason?: string;
}

export interface PiTurnSnapshot {
  sessionId: string;
  turnId: string | number;
  mode: "auto" | "yolo";
  cwd: string;
  configFingerprint: string;
  baseSandboxPolicy?: SandboxPolicy;
  sandboxReady?: boolean;
  escalationEligibility?: {
    eligible: boolean;
    reason: string;
  };
  transcript?: readonly unknown[];
}

export interface PiActionCall<Input = unknown> {
  readonly id: string;
  readonly tool: string;
  readonly input: Input;
  readonly cwd: string;
  readonly metadata?: unknown;
}

const CAPTURED_ACTION = Symbol("pi-safety-captured-action");

/** Opaque proof that the complete action identity was cloned at Pi ingress. */
export interface PiCapturedAction<Input = unknown> {
  readonly call: PiActionCall<Input>;
  readonly [CAPTURED_ACTION]: true;
}

/** The only execution capability shape visible to a Pi adapter. */
export interface PiExecutionAttempt<Input = unknown> {
  readonly call: PiActionCall<Input>;
  readonly mode: "sandboxed" | "host-admitted" | "escalated" | "unrestricted";
  readonly policy?: SandboxPolicy;
  readonly signal: AbortSignal;
  readonly authorizeCapability: (
    request: EngineCapabilityAuthorizationInput,
  ) => Promise<EngineCapabilityAuthorizationDecision>;
  readonly rejectCapability: (
    request: EngineCapabilityRejectionInput,
  ) => EngineCapabilityAuthorizationDecision;
}

export type PiActionOutcome<T> =
  | NativeActionFailure
  | { kind: "completed"; value: T }
  | {
      kind: "capability-denied";
      request: PiCapabilityRequest;
      detail?: string;
    }
  | { kind: "failed"; error: unknown };

export interface PiAction<Result, ReviewContext = undefined, Input = unknown> {
  /** One canonical call envelope captured before any asynchronous work. */
  readonly captured: PiCapturedAction<Input>;
  /** The facade derives Engine ownership, admission, and amendment intent. */
  readonly kind: PiActionKind;
  /** Static risk evidence captured for this exact action, when applicable. */
  readonly risk?: RiskDecision;
  readonly permission?: PiPermissionRequest;
  /** Trusted adapter declaration for post-start filesystem denial handling. */
  readonly runtimeDenialPolicy?: RuntimeDenialPolicy;
  readonly reviewContext: ReviewContext;
  readonly signal?: AbortSignal;
  /** Receives transient reviewer state for this exact tool row. */
  readonly reviewStatus?: ReviewStatusBinding;
  readonly execute: (attempt: PiExecutionAttempt<Input>) => Promise<PiActionOutcome<Result>>;
}

export interface PiPermissionError {
  readonly code: PermissionError["code"];
  readonly reason: string;
  readonly request?: PiCapabilityRequest;
  readonly effectsMayHaveOccurred?: true;
  readonly retryAttempted?: true;
}

export type PiExecutionOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "blocked"; error: PiPermissionError }
  | { kind: "failed"; error: unknown; effectsMayHaveOccurred?: true };

function toEngineRuntimeOutcome<T>(outcome: PiActionOutcome<T>): EngineRuntimeOutcome<T> {
  if (outcome.kind === "completed") return outcome;
  if (outcome.kind === "failed") return outcome;
  return outcome;
}

function fromEngineExecutionOutcome<T>(outcome: ExecutionOutcome<T>): PiExecutionOutcome<T> {
  if (outcome.kind === "completed") return outcome;
  if (outcome.kind === "failed") return outcome;
  return {
    kind: "blocked",
    error: {
      code: outcome.error.code,
      reason: outcome.error.reason,
      ...(outcome.error.request === undefined ? {} : { request: outcome.error.request }),
      ...(outcome.error.effectsMayHaveOccurred === true
        ? { effectsMayHaveOccurred: true as const }
        : {}),
      ...(outcome.error.retryAttempted === true ? { retryAttempted: true as const } : {}),
    },
  };
}

function engineOwnership(kind: PiActionKind): InvocationOwnership {
  if (kind === "host") return "host-admission";
  if (kind === "permission-amendment") return "permission-amendment";
  return "sandbox-owned";
}

/**
 * Non-production compatibility for `kind:"host"`. Product scope 2026-09-19:
 * register.ts no longer constructs host actions (foreign A / host-first B).
 * Do not wire host-first/foreign tool_call back to this projection.
 */
function hostAdmission(admission: EngineAdmissionPlan, tool: string): EngineAdmissionPlan {
  const requested = [{ kind: "external-tool" as const, provider: "pi-host", name: tool }];
  if (admission.kind === "deny") return admission;
  if (admission.kind === "allow") return { ...admission, requested };
  const existing = admission.residuals ?? [];
  const residuals = ensureNonEmptyResiduals(
    existing.includes("host_admission_review") ? existing : [...existing, "host_admission_review"],
  );
  return { ...admission, requested, review: "action", residuals };
}

function admissionForAction(
  action: {
    kind: PiActionKind;
    risk?: RiskDecision;
  },
  tool: string,
): EngineAdmissionPlan | undefined {
  if (action.risk === undefined) return undefined;
  const admission = admissionPlanFromRiskDecision(action.risk);
  return action.kind === "host" ? hostAdmission(admission, tool) : admission;
}

function intentForAction(
  action: { kind: PiActionKind; permission?: PiPermissionRequest },
  admission: EngineAdmissionPlan | undefined,
): EnginePermissionAmendment | undefined {
  if (action.kind !== "permission-amendment" || action.permission === undefined) return undefined;
  const requested = admission?.kind === "review" ? (admission.requested ?? []) : [];
  return {
    kind: "permission-amendment",
    requested,
    reason:
      action.permission.reason ?? (admission?.kind === "review" ? admission.reason : undefined),
  };
}

export interface ExactRetryDispatch {
  readonly denialId: string;
  readonly tool: string;
  readonly serializedInput: string;
  readonly cwd: string;
  readonly previousDenial: string;
}

export type RecoverDeniedActionResult =
  | { readonly kind: "armed"; readonly dispatch: ExactRetryDispatch }
  | { readonly kind: "empty" | "cancelled" | "stale" };

export interface PiSafetyOptions<ReviewContext = undefined> {
  guardian?: GuardianAdapter<ReviewContext>;
  policy?: PermissionPolicy;
  reviewEventSink?: (event: ReviewEvent) => void;
  onAutoStateChange?: (
    state: AutoState,
    context: ExtensionContext | undefined,
    newlyPaused: boolean,
  ) => void;
}

export interface PiSafety<ReviewContext = undefined> {
  beginTurn(snapshot: PiTurnSnapshot, context: ExtensionContext): void;
  /**
   * Open an isolated child turn for a delegated subagent. The child runs on
   * a fresh Engine (empty grants/amendments/circuit) while the parent turn
   * is parked untouched; submit() routes to the innermost turn.
   */
  beginNestedTurn(snapshot: PiTurnSnapshot, context: ExtensionContext): void;
  /** Close the innermost child turn and restore its parent. */
  closeNestedTurn(reason?: string): void;
  /** True while at least one delegated child turn is open. */
  hasNestedTurn(): boolean;
  hasActiveTurn(): boolean;
  /**
   * Apply a host mode change to the live turn without beginTurn. Walks the
   * nested stack so parked parents stay aligned with the child.
   */
  refreshTurnMode(patch: {
    mode: "auto" | "yolo";
    sandboxReady?: boolean;
    baseSandboxPolicy?: SandboxPolicy;
    escalationEligibility?: { eligible: boolean; reason: string };
  }): boolean;
  inspect(): PermissionStateView | undefined;
  /**
   * Submit an opaque action capture produced at host ingress. The action's
   * executor receives the Engine's canonical call rather than any mutable
   * object that the host originally supplied.
   */
  submit<Result, Input = unknown>(
    action: PiAction<Result, ReviewContext, Input>,
  ): Promise<PiExecutionOutcome<Result>>;
  captureAction<Input>(call: PiActionCall<Input>): PiCapturedAction<Input>;
  closeTurn(reason?: string): void;
  invalidate(reason: string): void;
  recoverDeniedAction(ui: ExtensionUIContext): Promise<RecoverDeniedActionResult>;
}

const NO_ACTIVE_TURN: PermissionError = {
  code: "no-active-turn",
  reason: "No active permission turn is available",
};

function reviewUi(context: ExtensionContext | undefined): ReviewUi | undefined {
  if (context?.mode !== "tui" || !context.hasUI) return undefined;
  return context.ui;
}

function retryChoice(
  denial: {
    call: { tool: string; input: unknown };
    summary?: string;
    rationale: string;
  },
  index: number,
): string {
  const summary = (denial.summary ?? denial.call.tool).replace(/\s+/g, " ").trim().slice(0, 120);
  const rationale = denial.rationale.replace(/\s+/g, " ").trim().slice(0, 160);
  return `${index + 1}. ${denial.call.tool}: ${summary} — ${rationale}`;
}

export class PiSafetyRuntime<ReviewContext = undefined> implements PiSafety<ReviewContext> {
  private engine: ApproveForMeEngine<ReviewContext>;
  private readonly presenter: ReviewPresenter;
  private readonly options: PiSafetyOptions<ReviewContext>;
  private activeTurn: TurnHandle<ReviewContext> | undefined;
  private currentContext: ExtensionContext | undefined;
  private circuitPauseNotified = false;
  /**
   * Parked parent levels while a delegated child turn is open.
   * The child Engine is fresh (no shared grants); the parent resumes
   * byte-identical on closeNestedTurn.
   */
  private nestedLevels: Array<{
    engine: ApproveForMeEngine<ReviewContext>;
    turn: TurnHandle<ReviewContext> | undefined;
    context: ExtensionContext | undefined;
  }> = [];

  constructor(options: PiSafetyOptions<ReviewContext> = {}) {
    this.options = options;
    this.presenter = new ReviewPresenter();
    this.engine = this.createEngine();
  }

  private createEngine(): ApproveForMeEngine<ReviewContext> {
    return createApproveForMeEngine<ReviewContext>({
      guardian: this.options.guardian,
      policy: this.options.policy,
      onReviewEvent: (event) => this.handleReviewEvent(event),
      onAutoStateChange: (state) => this.handleAutoStateChange(state),
    });
  }

  inspect(): PermissionStateView | undefined {
    return this.engine.inspect();
  }

  beginTurn(snapshot: PiTurnSnapshot, context: ExtensionContext): void {
    if (this.activeTurn) this.closeTurn("turn replaced");
    this.discardNestedLevels("turn replaced");
    this.currentContext = context;
    this.circuitPauseNotified = false;
    this.activeTurn = this.engine.beginTurn(snapshot);
  }

  beginNestedTurn(snapshot: PiTurnSnapshot, context: ExtensionContext): void {
    // Build the child completely before changing the live engine or parking
    // the parent. A malformed snapshot or engine-construction failure must
    // leave the parent usable so the host can install its fail-closed
    // session-only sentinel.
    const childEngine = this.createEngine();
    const childTurn = childEngine.beginTurn(snapshot);
    this.nestedLevels.push({
      engine: this.engine,
      turn: this.activeTurn,
      context: this.currentContext,
    });
    this.engine = childEngine;
    this.currentContext = context;
    this.circuitPauseNotified = false;
    this.activeTurn = childTurn;
  }

  closeNestedTurn(reason = "nested turn closed"): void {
    const parent = this.nestedLevels.pop();
    // No parked level (e.g. a session-only fallback nesting): leave the live
    // turn untouched instead of tearing it down.
    if (!parent) return;
    this.activeTurn?.close(reason);
    this.engine = parent.engine;
    this.activeTurn = parent.turn;
    this.currentContext = parent.context;
    this.circuitPauseNotified = false;
  }

  hasNestedTurn(): boolean {
    return this.nestedLevels.length > 0;
  }

  private discardNestedLevels(reason: string): void {
    while (this.nestedLevels.length > 0) {
      const level = this.nestedLevels.pop();
      level?.turn?.close(reason);
      level?.engine.invalidate(reason);
    }
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== undefined;
  }

  refreshTurnMode(patch: {
    mode: "auto" | "yolo";
    sandboxReady?: boolean;
    baseSandboxPolicy?: SandboxPolicy;
    escalationEligibility?: { eligible: boolean; reason: string };
  }): boolean {
    let refreshed = false;
    for (const level of this.nestedLevels) {
      if (level.engine.refreshTurnMode(patch)) refreshed = true;
    }
    if (this.engine.refreshTurnMode(patch)) refreshed = true;
    return refreshed;
  }

  captureAction<Input>(call: PiActionCall<Input>): PiCapturedAction<Input> {
    let input: Input;
    let metadata: unknown;
    try {
      input = structuredClone(call.input) as Input;
      metadata = call.metadata === undefined ? undefined : structuredClone(call.metadata);
    } catch {
      throw new Error("Action identity must be structured-cloneable");
    }
    return Object.freeze({
      call: Object.freeze({
        id: call.id,
        tool: call.tool,
        input,
        cwd: resolve(call.cwd),
        ...(metadata === undefined ? {} : { metadata }),
      }),
      [CAPTURED_ACTION]: true as const,
    });
  }

  async submit<Result, Input = unknown>(
    action: PiAction<Result, ReviewContext, Input>,
  ): Promise<PiExecutionOutcome<Result>> {
    const turn = this.activeTurn;
    if (!turn) return { kind: "blocked", error: { ...NO_ACTIVE_TURN } };
    if (action.captured?.[CAPTURED_ACTION] !== true) {
      return {
        kind: "blocked",
        error: { code: "policy-denied", reason: "Action was not captured at Pi ingress" },
      };
    }
    const capturedCall = action.captured.call;
    const unbindReviewStatus = action.reviewStatus
      ? this.presenter.bind(capturedCall.id, action.reviewStatus)
      : undefined;
    const execute = action.execute;
    const admission = admissionForAction(action, capturedCall.tool);
    const intent = intentForAction(action, admission);
    const invocation: Invocation<Result, ReviewContext> = {
      ownership: engineOwnership(action.kind),
      call: {
        id: capturedCall.id,
        tool: capturedCall.tool,
        input: capturedCall.input,
        cwd: capturedCall.cwd,
        ...(capturedCall.metadata === undefined ? {} : { metadata: capturedCall.metadata }),
      },
      ...(admission === undefined ? {} : { admission }),
      ...(intent === undefined ? {} : { intent }),
      ...(action.runtimeDenialPolicy === undefined
        ? {}
        : { runtimeDenialPolicy: action.runtimeDenialPolicy }),
      reviewContext: action.reviewContext,
      signal: action.signal,
      executor: async (attempt: EngineExecutionAttempt) => {
        const context: PiExecutionAttempt<Input> = {
          call: {
            id: attempt.call.id,
            tool: attempt.call.tool,
            input: attempt.call.input as Input,
            cwd: attempt.call.cwd,
            ...(attempt.call.metadata === undefined ? {} : { metadata: attempt.call.metadata }),
          },
          mode: attempt.lease.mode,
          ...(attempt.lease.policy === undefined ? {} : { policy: attempt.lease.policy }),
          signal: attempt.signal,
          authorizeCapability: attempt.authorizeCapability,
          rejectCapability: attempt.rejectCapability,
        };
        const outcome = await execute(context);
        return toEngineRuntimeOutcome(outcome);
      },
    };
    try {
      return fromEngineExecutionOutcome(await turn.execute(invocation));
    } finally {
      unbindReviewStatus?.();
    }
  }

  closeTurn(reason = "turn closed"): void {
    const turn = this.activeTurn;
    const ui = reviewUi(this.currentContext);
    this.discardNestedLevels(reason);
    this.activeTurn = undefined;
    this.currentContext = undefined;
    this.circuitPauseNotified = false;
    this.presenter.reset(ui);
    turn?.close(reason);
  }

  invalidate(reason: string): void {
    const ui = reviewUi(this.currentContext);
    this.discardNestedLevels(reason);
    this.activeTurn = undefined;
    this.currentContext = undefined;
    this.circuitPauseNotified = false;
    this.presenter.reset(ui);
    this.engine.invalidate(reason);
  }

  async recoverDeniedAction(ui: ExtensionUIContext): Promise<RecoverDeniedActionResult> {
    let denials: DenialNotice[];
    try {
      denials = [...this.engine.listDenials()].reverse();
    } catch {
      return { kind: "stale" };
    }
    if (denials.length === 0) return { kind: "empty" };

    const choices = denials.map((denial, index) => retryChoice(denial, index));
    let choice: string | undefined;
    try {
      choice = await ui.select("Auto-review denials", choices);
    } catch {
      return { kind: "cancelled" };
    }
    if (choice === undefined) return { kind: "cancelled" };
    const selectedIndex = choices.indexOf(choice);
    const denial = selectedIndex < 0 ? undefined : denials[selectedIndex];
    if (!denial) return { kind: "stale" };
    let serializedInput: string;
    try {
      serializedInput = JSON.stringify(denial.call.input) ?? "null";
    } catch {
      return { kind: "stale" };
    }
    if (!this.engine.armRetry(denial.handle)) return { kind: "stale" };

    const dispatch: ExactRetryDispatch = Object.freeze({
      denialId: denial.handle.token,
      tool: denial.call.tool,
      serializedInput,
      cwd: denial.call.cwd,
      previousDenial: denial.rationale,
    });
    return { kind: "armed", dispatch };
  }

  private handleReviewEvent(event: ReviewEvent): void {
    try {
      this.options.reviewEventSink?.(event);
    } catch {
      // External event consumers are observational and isolated from TUI state.
    }
    try {
      this.presenter.accept(event, reviewUi(this.currentContext));
    } catch {
      // Presentation is observational and must not affect authorization.
    }
  }

  private handleAutoStateChange(state: AutoState): void {
    if (!state.paused) this.circuitPauseNotified = false;
    const newlyPaused = state.paused && !this.circuitPauseNotified;
    if (newlyPaused) this.circuitPauseNotified = true;
    try {
      this.options.onAutoStateChange?.(state, this.currentContext, newlyPaused);
    } catch {
      // Host status and notification failures must not affect authorization.
    }
  }
}
