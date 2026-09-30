import { describe, expect, it } from "vitest";
import {
  codexBashToolSpec,
  codexEditToolSpec,
  codexFindToolSpec,
  codexGrepToolSpec,
  codexLsToolSpec,
  codexReadToolSpec,
  codexWriteToolSpec,
  createCodexToolRendering,
  createEditDiffBox,
  parseEditDiff,
  withCodexToolPresentation,
} from "../src/index.ts";

describe("shared-tool-presentation", () => {
  it("exports complete 7-tool Codex rendering suite", () => {
    expect(typeof withCodexToolPresentation).toBe("function");
    expect(typeof createCodexToolRendering).toBe("function");
    expect(typeof createEditDiffBox).toBe("function");
    expect(typeof parseEditDiff).toBe("function");

    expect(codexBashToolSpec.runningVerb).toBe("Running");
    expect(codexEditToolSpec.runningVerb).toBe("Editing");
    expect(codexWriteToolSpec.runningVerb).toBe("Writing");
    expect(codexReadToolSpec.runningVerb).toBe("Reading");
    expect(codexGrepToolSpec.runningVerb).toBe("Searching");
    expect(codexFindToolSpec.runningVerb).toBe("Finding");
    expect(codexLsToolSpec.runningVerb).toBe("Listing");
  });
});
