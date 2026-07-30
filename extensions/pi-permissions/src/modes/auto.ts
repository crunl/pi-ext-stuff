import { MAX_CONSECUTIVE_GUARDIAN_DENIALS } from "../guardian-policy.ts";

export interface AutoState {
  consecutiveDenials: number;
  paused: boolean;
}

export const resetAutoState = (): AutoState => ({
  consecutiveDenials: 0,
  paused: false,
});

export const recordAutoApproval = (_state: AutoState): AutoState => resetAutoState();

export function recordAutoDenial(state: AutoState): AutoState {
  const consecutiveDenials = state.consecutiveDenials + 1;
  return {
    consecutiveDenials,
    paused: state.paused || consecutiveDenials >= MAX_CONSECUTIVE_GUARDIAN_DENIALS,
  };
}

export function recordAutoDecision(
  state: AutoState,
  decision: "approve" | "deny" | "escalate",
): AutoState {
  if (decision === "approve") return recordAutoApproval(state);
  if (decision === "escalate") return { ...state, paused: true };
  return recordAutoDenial(state);
}
