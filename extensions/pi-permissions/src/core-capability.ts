export const CORE_EXECUTION_ABORT_GATE_SYMBOL = Symbol.for(
  "pi-permissions.core.execution-abort-gate.v1",
);

export function hasCoreExecutionAbortGate(): boolean {
  return (globalThis as Record<symbol, unknown>)[CORE_EXECUTION_ABORT_GATE_SYMBOL] === 1;
}
