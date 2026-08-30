import { resolve } from "node:path";

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type ApproveForMeEngine,
  type AutoState,
  createApproveForMeEngine,
  type DenialNotice,
  type AdmissionPlan as EngineAdmissionPlan,
  type CapabilityAuthorizationDecision as EngineCapabilityAuthorizationDecision,
  type CapabilityAuthorizationRequest as EngineCapabilityAuthorizationRequest,
  type CapabilityRequestInput as EngineCapabilityRequestInput,
  type ExecutionAttempt as EngineExecutionAttempt,
  type PermissionAmendment as EnginePermissionAmendment,
  type RuntimeOutcome as EngineRuntimeOutcome,
  type ExecutionOutcome,
  type GuardianAdapter,
  type Invocation,
  type InvocationOwnership,
  type PermissionError,
  type PermissionPolicy,
  type ReviewEvent,
  type TurnHandle,
} from "./approve-for-me-engine.ts";
import type { StructuredExecutionPlan } from "./execution-plan.ts";
import { admissionPlanFromRiskDecision } from "./pi-approve-for-me-adapters.ts";
import type { ReviewUi } from "./review-presenter.ts";
import { ReviewPresenter, type ReviewStatusBinding } from "./review-presenter.ts";
import type { RiskDecision } from "./risk-policy.ts";
import type { SandboxPolicy } from "./sandbox.ts";

/**
 * Pi's ingress vocabulary. The Engine remains an implementation detail of
 * this module; register.ts only deals in actions and execution contexts.
 */
export type PiActionKind = "sandbox" | "host" | "permission-amendment";

export type PiCapabilityRequest = EngineCapabilityRequestInput;

export interface PiPermissionRequest {
  scope: "turn" | "session";
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
  transcript?: readonly unknown[];
}

export interface PiActionCall<Input = unknown> {
  readonly id: string;
  readonly tool: string;
  readonly input: Input;
  readonly cwd: string;
  readonly metadata?: unknown;
}

const CAPTURED_ACTION = Symbol("pi-permissions-captured-action");

/** Opaque proof that the complete action identity was cloned at Pi ingress. */
export interface PiCapturedAction<Input = unknown> {
  readonly call: PiActionCall<Input>;
  readonly [CAPTURED_ACTION]: true;
}

/** The only execution capability shape visible to a Pi adapter. */
export interface PiExecutionAttempt<Input = unknown> {
  readonly ordinal: 0 | 1;
  readonly call: PiActionCall<Input>;
  readonly mode: "sandboxed" | "host-admitted" | "unrestricted";
  readonly policy?: SandboxPolicy;
  readonly plan?: StructuredExecutionPlan;
}

export type PiActionOutcome<T> =
  | { kind: "completed"; value: T }
  | {
      kind: "capability-denied";
      request: PiCapabilityRequest;
      retryability: "safe" | "uncertain";
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
}

export type PiExecutionOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "blocked"; error: PiPermissionError }
  | { kind: "failed"; error: unknown };

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
    },
  };
}

function engineOwnership(kind: PiActionKind): InvocationOwnership {
  if (kind === "host") return "host-admission";
  if (kind === "permission-amendment") return "permission-amendment";
  return "sandbox-owned";
}

function hostAdmission(admission: EngineAdmissionPlan, tool: string): EngineAdmissionPlan {
  const requested = [{ kind: "external-tool" as const, provider: "pi-host", name: tool }];
  if (admission.kind === "deny") return admission;
  if (admission.kind === "allow") return { ...admission, requested };
  return { ...admission, requested, review: "action" };
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
    scope: action.permission.scope,
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

export interface PiPermissionsOptions<ReviewContext = undefined> {
  guardian?: GuardianAdapter<ReviewContext>;
  policy?: PermissionPolicy;
  reviewEventSink?: (event: ReviewEvent) => void;
  onAutoStateChange?: (
    state: AutoState,
    context: ExtensionContext | undefined,
    newlyPaused: boolean,
  ) => void;
}

export interface PiPermissions<ReviewContext = undefined> {
  beginTurn(snapshot: PiTurnSnapshot, context: ExtensionContext): void;
  hasActiveTurn(): boolean;
  /**
   * Submit an opaque action capture produced at host ingress. The action's
   * executor receives the Engine's canonical call rather than any mutable
   * object that the host originally supplied.
   */
  submit<Result, Input = unknown>(
    action: PiAction<Result, ReviewContext, Input>,
  ): Promise<PiExecutionOutcome<Result>>;
  authorizeCapability(
    request: Omit<EngineCapabilityAuthorizationRequest, "call"> & {
      call: PiActionCall;
    },
  ): Promise<EngineCapabilityAuthorizationDecision>;
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

export class PiPermissionsRuntime<ReviewContext = undefined>
  implements PiPermissions<ReviewContext>
{
  private readonly engine: ApproveForMeEngine<ReviewContext>;
  private readonly presenter: ReviewPresenter;
  private readonly options: PiPermissionsOptions<ReviewContext>;
  private activeTurn: TurnHandle<ReviewContext> | undefined;
  private currentContext: ExtensionContext | undefined;
  private circuitPauseNotified = false;

  constructor(options: PiPermissionsOptions<ReviewContext> = {}) {
    this.options = options;
    this.presenter = new ReviewPresenter();
    this.engine = createApproveForMeEngine<ReviewContext>({
      guardian: options.guardian,
      policy: options.policy,
      onReviewEvent: (event) => this.handleReviewEvent(event),
      onAutoStateChange: (state) => this.handleAutoStateChange(state),
    });
  }

  beginTurn(snapshot: PiTurnSnapshot, context: ExtensionContext): void {
    if (this.activeTurn) this.closeTurn("turn replaced");
    this.currentContext = context;
    this.circuitPauseNotified = false;
    this.activeTurn = this.engine.beginTurn(snapshot);
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== undefined;
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
      reviewContext: action.reviewContext,
      signal: action.signal,
      executor: async (attempt: EngineExecutionAttempt) => {
        const context: PiExecutionAttempt<Input> = {
          ordinal: attempt.ordinal,
          call: {
            id: attempt.call.id,
            tool: attempt.call.tool,
            input: attempt.call.input as Input,
            cwd: attempt.call.cwd,
            ...(attempt.call.metadata === undefined ? {} : { metadata: attempt.call.metadata }),
          },
          mode: attempt.lease.mode,
          ...(attempt.lease.policy === undefined ? {} : { policy: attempt.lease.policy }),
          ...(attempt.plan === undefined ? {} : { plan: attempt.plan }),
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

  async authorizeCapability(
    request: Omit<EngineCapabilityAuthorizationRequest, "call"> & {
      call: PiActionCall;
    },
  ): Promise<EngineCapabilityAuthorizationDecision> {
    const turn = this.activeTurn;
    if (!turn) {
      return {
        kind: "deny",
        error: { code: "no-active-turn", reason: NO_ACTIVE_TURN.reason },
      };
    }
    return turn.authorizeCapability({
      ...request,
      call: {
        id: request.call.id,
        tool: request.call.tool,
        input: request.call.input,
        cwd: resolve(request.call.cwd),
        ...(request.call.metadata === undefined ? {} : { metadata: request.call.metadata }),
      },
    });
  }

  closeTurn(reason = "turn closed"): void {
    const turn = this.activeTurn;
    const ui = reviewUi(this.currentContext);
    this.activeTurn = undefined;
    this.currentContext = undefined;
    this.circuitPauseNotified = false;
    this.presenter.reset(ui);
    turn?.close(reason);
  }

  invalidate(reason: string): void {
    const ui = reviewUi(this.currentContext);
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
