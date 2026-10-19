import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  formatGuardianMetricsSummary,
  type GuardianMetricsRecord,
  summarizeGuardianMetrics,
} from "../src/guardian/metrics.ts";
import { isRecord } from "../src/unknown-value.ts";

function metricsPath(): string {
  const fromArgs = process.argv.indexOf("--file");
  if (fromArgs !== -1 && process.argv[fromArgs + 1]) return process.argv[fromArgs + 1];
  return join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"),
    "guardian-metrics.jsonl",
  );
}

const records: GuardianMetricsRecord[] = [];
let skipped = 0;
let raw = "";
try {
  raw = await readFile(metricsPath(), "utf8");
} catch {
  raw = "";
}
for (const line of raw.split("\n")) {
  const trimmed = line.trim();
  if (trimmed === "") continue;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      isRecord(parsed) &&
      typeof parsed.terminal_status === "string" &&
      typeof parsed.action === "string" &&
      typeof parsed.duration_ms === "number" &&
      isRecord(parsed.token_usage)
    ) {
      // SAFETY: shape-gated above (terminal_status/action strings, numeric
      // duration, record token_usage); remaining optional record fields only
      // widen the summary, and sanitizeMetricTag already hardened the builder
      // against hostile values, so a best-effort report cast is sound.
      records.push(parsed as unknown as GuardianMetricsRecord);
    } else {
      skipped += 1;
    }
  } catch {
    skipped += 1;
  }
}

process.stdout.write(formatGuardianMetricsSummary(summarizeGuardianMetrics(records)));
if (skipped > 0) {
  process.stdout.write(`skipped malformed lines: ${skipped}\n`);
}
