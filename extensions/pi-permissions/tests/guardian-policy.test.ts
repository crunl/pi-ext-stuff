import { describe, expect, it } from "vitest";
import { guardianRetryDelayMs } from "../src/guardian-policy.ts";

describe("Guardian policy", () => {
  it("backs off retries and caps their delay", () => {
    expect([
      guardianRetryDelayMs(1),
      guardianRetryDelayMs(2),
      guardianRetryDelayMs(3),
      guardianRetryDelayMs(4),
      guardianRetryDelayMs(12),
    ]).toEqual([250, 500, 1_000, 1_000, 1_000]);
  });
});
