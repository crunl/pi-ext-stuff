import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GuardianWorkerClient } from "../src/guardian-worker-client.ts";
import { createGuardianEvidenceScope } from "../src/sandbox.ts";

/**
 * Guardian worker RSS probe. The worker is a separate child process
 * (child_process.spawn, guardian-worker-client.ts), so its memory never
 * shows in the host heap: it must be sampled from the OS.
 *
 * The worker is session-lived by design (no idle retirement; it is closed
 * on sandbox reset). This probe answers: does RSS grow across repeated
 * reviews? A bounded working set is expected to grow once (bootstrap +
 * module load) and then stay flat.
 */

const clients: GuardianWorkerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
});

function evidenceScope(cwd: string) {
  return createGuardianEvidenceScope(cwd, {
    filesystem: { allowWrite: [cwd], denyRead: [], denyWrite: [] },
    network: { allowedDomains: [], deniedDomains: [] },
  });
}

function rssKb(pid: number): number {
  // darwin and linux both support `ps -o rss= -p <pid>`; values are KB.
  const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const value = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(value)) throw new Error(`could not read RSS for pid ${pid}`);
  return value;
}

describe("Guardian worker RSS", () => {
  it("does not grow unbounded across repeated reviews", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-guardian-rss-"));
    const client = new GuardianWorkerClient(evidenceScope(directory));
    clients.push(client);

    // Warmup: bootstrap + module load dominate the first execution.
    for (let i = 0; i < 3; i += 1) {
      await client.execute({
        cwd: directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      });
    }
    if (!client.pid) throw new Error("worker has no pid");
    const warmRss = rssKb(client.pid);

    for (let i = 0; i < 15; i += 1) {
      await client.execute({
        cwd: directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      });
    }
    const soakedRss = rssKb(client.pid);

    // A leak would be linear in reviews (~hundreds of KB each); normal
    // allocator churn is a small fraction of the warm baseline.
    const growth = soakedRss - warmRss;
    expect(growth).toBeLessThan(Math.max(8 * 1024, warmRss * 0.5));
  }, 60_000);
});
