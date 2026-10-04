import { describe, expect, it } from "vitest";
import {
  BADGE_CAP_WIDTH,
  codexBashToolSpec,
  codexEditToolSpec,
  codexFindToolSpec,
  codexGrepToolSpec,
  codexLsToolSpec,
  codexReadToolSpec,
  codexWriteToolSpec,
  contrastTextFor,
  createCodexToolRendering,
  createEditDiffBox,
  isPermissionsModeEvent,
  makeModeBadgeDecorator,
  parseEditDiff,
  parseTruecolor,
  PermissionsModeState,
  PL_LEFT,
  PL_RIGHT,
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

  it("re-exports the badge and permissions-mode surfaces", () => {
    expect(BADGE_CAP_WIDTH).toBe(2);
    expect(typeof parseTruecolor).toBe("function");
    expect(typeof contrastTextFor).toBe("function");
    expect(typeof makeModeBadgeDecorator).toBe("function");
    expect(typeof PL_LEFT).toBe("string");
    expect(typeof PL_RIGHT).toBe("string");
    expect(typeof isPermissionsModeEvent).toBe("function");
    expect(typeof PermissionsModeState).toBe("function");
  });
});
