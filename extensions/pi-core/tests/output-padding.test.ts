import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputPaddingController } from "../src/tui/output-padding.ts";

const temporaryDirectories: string[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-core-output-padding-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSettings(directory: string, outputPad: 0 | 1): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({ outputPad }),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OutputPaddingController", () => {
  it("watches global output padding and invalidates registered tool rows", async () => {
    const root = createDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    writeSettings(agentDir, 1);

    const controller = new OutputPaddingController(agentDir);
    controller.start(cwd, false);
    const invalidate = vi.fn();
    controller.track("tool-1", invalidate);

    await new Promise((resolve) => setTimeout(resolve, 150));
    writeSettings(agentDir, 0);

    await vi.waitFor(() => {
      expect(controller.getOutputPad()).toBe(0);
      expect(invalidate).toHaveBeenCalledTimes(1);
    });
    controller.stop();
  });

  it("honors trusted project settings and ignores them when untrusted", () => {
    const root = createDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    writeSettings(agentDir, 1);
    writeSettings(join(cwd, ".pi"), 0);

    const controller = new OutputPaddingController(agentDir);
    controller.start(cwd, true);
    expect(controller.getOutputPad()).toBe(0);

    controller.start(cwd, false);
    expect(controller.getOutputPad()).toBe(1);
    controller.stop();
  });
});
