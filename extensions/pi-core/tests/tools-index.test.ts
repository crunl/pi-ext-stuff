import { describe, expect, it, vi } from "vitest";
import { registerBuiltInTools } from "../src/tools/index.ts";

function fakePi(active: string[], builtins: string[]) {
  const handlers: Record<string, () => void> = {};
  const setActiveTools = vi.fn();
  const pi = {
    on(event: string, handler: () => void) {
      handlers[event] = handler;
    },
    getAllTools: () => builtins.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
    getActiveTools: () => active,
    setActiveTools,
  };
  return { pi: pi as never, emit: () => handlers.session_start(), setActiveTools };
}

describe("registerBuiltInTools", () => {
  it("activates every builtin tool at session start", () => {
    const { pi, emit, setActiveTools } = fakePi(
      ["read", "bash"],
      ["read", "bash", "grep", "find", "ls"],
    );
    registerBuiltInTools(pi);
    emit();
    expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls"]);
  });

  it("keeps non-builtin tools while merging builtins", () => {
    const { pi, emit, setActiveTools } = fakePi(["read", "custom"], ["read", "grep"]);
    registerBuiltInTools(pi);
    emit();
    expect(setActiveTools).toHaveBeenCalledWith(["read", "custom", "grep"]);
  });

  it("skips setActiveTools when every builtin is already active", () => {
    const { pi, emit, setActiveTools } = fakePi(["read", "grep"], ["read", "grep"]);
    registerBuiltInTools(pi);
    emit();
    expect(setActiveTools).not.toHaveBeenCalled();
  });
});
