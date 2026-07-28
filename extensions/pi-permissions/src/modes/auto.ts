export interface AutoState {
  consecutiveDenials: number;
  paused: boolean;
}

export function recordAutoDecision(
  state: AutoState,
  decision: "approve" | "deny" | "escalate",
  limit: number,
): AutoState {
  if (decision === "approve") return { consecutiveDenials: 0, paused: false };
  if (decision === "escalate") return { ...state, paused: true };
  const consecutiveDenials = state.consecutiveDenials + 1;
  return { consecutiveDenials, paused: consecutiveDenials >= limit };
}
