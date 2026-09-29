import { describe, expect, it } from "vitest";
import {
  codexBashToolSpec,
  codexEditToolSpec,
  codexWriteToolSpec,
  createCodexToolRendering,
  withCodexToolPresentation,
} from "../src/index.ts";

describe("shared-tool-presentation", () => {
  it("exports complete Codex rendering suite", () => {
    expect(typeof withCodexToolPresentation).toBe("function");
    expect(typeof createCodexToolRendering).toBe("function");
    expect(codexBashToolSpec.runningVerb).toBe("Running");
    expect(codexEditToolSpec.runningVerb).toBe("Editing");
    expect(codexWriteToolSpec.runningVerb).toBe("Writing");
  });
});
