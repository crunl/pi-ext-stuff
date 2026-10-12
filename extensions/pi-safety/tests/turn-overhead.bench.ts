import { bench, describe } from "vitest";
import {
  classifyRiskWithCause,
  type PermissionRequest,
} from "../src/permissions/risk.ts";
import { evaluateRiskRequest } from "../src/risk-policy.ts";
import { appendGuardianTranscript, type GuardianTranscriptEntry } from "../src/guardian-transcript.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

/**
 * Extension-overhead micro-benchmarks (no LLM, no sandbox spawn).
 * Run: npm run bench
 *
 * Three cost centers identified in the performance survey:
 * 1. static verdict (classifyRiskWithCause) with precomputed segments —
 *    isolates the verdict from the parse
 * 2. full risk evaluation (evaluateRiskRequest) — includes BOTH shell
 *    parses (git-network.ts + risk.ts) on the auto path
 * 3. transcript append at the raw cap — measures the head-drop eviction
 *    path that runs on every message_end
 */

const simpleRequest = (): PermissionRequest => ({
  tool: "bash",
  operation: "execute",
  cwd: "/workspace",
  input: { command: "ps aux" },
  resolvedPaths: [],
});

const complexCommand = [
  "git fetch origin &&",
  "FOO=$(cat config.json) &&",
  "docker run -v /data:/data alpine sh -c 'echo done' |",
  "tee /tmp/out.log &&",
  "curl -s https://api.example.com/v1/endpoint --data @payload.json",
].join(" ");

describe("static risk classification (verdict only, segments precomputed)", () => {
  bench("simple command (ps aux)", () => {
    classifyRiskWithCause(simpleRequest());
  });

  bench("dangerous command (rm -f)", () => {
    classifyRiskWithCause({
      tool: "bash",
      operation: "execute",
      cwd: "/workspace",
      input: { command: "rm -rf /workspace/build" },
      resolvedPaths: [],
    });
  });
});

describe("full risk evaluation (includes shell AST parse x2)", () => {
  bench("simple command", async () => {
    await evaluateRiskRequest("bash", { command: "ps aux" }, "/workspace", DEFAULT_CONFIG);
  });

  bench("compound pipeline command", async () => {
    await evaluateRiskRequest("bash", { command: complexCommand }, "/workspace", DEFAULT_CONFIG);
  });
});

describe("transcript append at raw cap (head-drop eviction)", () => {
  const fat = "x".repeat(5_000);
  let entries: GuardianTranscriptEntry[] = [];
  for (let index = 0; index < 500; index += 1) {
    entries = appendGuardianTranscript(entries, { role: "assistant", content: fat }).entries;
  }

  bench("append one 5KB entry at cap", () => {
    appendGuardianTranscript(entries, { role: "assistant", content: fat });
  });
});
