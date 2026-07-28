export interface AutoState {
  consecutiveDenials: number;
  paused: boolean;
}

export const resetAutoState = (): AutoState => ({
  consecutiveDenials: 0,
  paused: false,
});

export const recordAutoApproval = (_state: AutoState): AutoState =>
  resetAutoState();

export function recordAutoDenial(state: AutoState, limit: number): AutoState {
  const consecutiveDenials = state.consecutiveDenials + 1;
  return {
    consecutiveDenials,
    paused: state.paused || consecutiveDenials >= limit,
  };
}

export function recordAutoDecision(
  state: AutoState,
  decision: "approve" | "deny" | "escalate",
  limit: number,
): AutoState {
  if (decision === "approve") return recordAutoApproval(state);
  if (decision === "escalate") return { ...state, paused: true };
  return recordAutoDenial(state, limit);
}
