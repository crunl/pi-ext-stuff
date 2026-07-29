import type { AutoReviewApprovalOverride } from "./auto-review-request.ts";

const MAX_RECENT_DENIALS = 10;

export interface AutoDeniedAction {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  configFingerprint: string;
  actionFingerprint: string;
  summary: string;
  rationale: string;
}

type NewAutoDeniedAction = Omit<AutoDeniedAction, "id">;

interface OverrideMatch {
  actionFingerprint: string;
  cwd: string;
  configFingerprint: string;
}

interface PendingOverride extends AutoReviewApprovalOverride, OverrideMatch {}

function cloneDenial(denial: AutoDeniedAction): AutoDeniedAction {
  return structuredClone(denial);
}

export class AutoApprovalLedger {
  private readonly denials: AutoDeniedAction[] = [];
  private pendingOverride: PendingOverride | undefined;
  private sequence = 0;

  recordDenial(denial: NewAutoDeniedAction): AutoDeniedAction {
    const recorded = {
      ...structuredClone(denial),
      id: `denial-${++this.sequence}`,
    };
    this.denials.push(recorded);
    if (this.denials.length > MAX_RECENT_DENIALS) {
      this.denials.splice(0, this.denials.length - MAX_RECENT_DENIALS);
    }
    return cloneDenial(recorded);
  }

  listDenials(): AutoDeniedAction[] {
    return this.denials.map(cloneDenial);
  }

  approveDenial(id: string): AutoDeniedAction | undefined {
    const index = this.denials.findIndex((denial) => denial.id === id);
    if (index < 0) return undefined;
    const [denial] = this.denials.splice(index, 1);
    if (!denial) return undefined;
    this.pendingOverride = {
      denialId: denial.id,
      actionFingerprint: denial.actionFingerprint,
      cwd: denial.cwd,
      configFingerprint: denial.configFingerprint,
    };
    return cloneDenial(denial);
  }

  takeOverride(match: OverrideMatch): AutoReviewApprovalOverride | undefined {
    const pending = this.pendingOverride;
    if (
      !pending
      || pending.actionFingerprint !== match.actionFingerprint
      || pending.cwd !== match.cwd
      || pending.configFingerprint !== match.configFingerprint
    ) {
      return undefined;
    }
    this.pendingOverride = undefined;
    return {
      denialId: pending.denialId,
      actionFingerprint: pending.actionFingerprint,
    };
  }

  clear(): void {
    this.denials.length = 0;
    this.pendingOverride = undefined;
  }
}
