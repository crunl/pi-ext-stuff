import { describe, expect, it, vi } from "vitest";
import { DEFAULT_NETWORK_RESOLUTION_TIMEOUT_MS, NetworkBoundary } from "../src/network-boundary.ts";

describe("NetworkBoundary", () => {
  it("uses Codex's two-second DNS resolution budget by default", () => {
    expect(DEFAULT_NETWORK_RESOLUTION_TIMEOUT_MS).toBe(2_000);
  });

  it("allows public DNS answers but rejects private or special answers", async () => {
    const resolveHost = vi.fn(async (host: string) =>
      host === "public.example" ? ["93.184.216.34"] : ["127.0.0.1"],
    );
    const boundary = new NetworkBoundary({ resolveHost });

    await expect(boundary.resolveEndpoint("public.example", 443)).resolves.toEqual({
      kind: "allow",
      endpoint: { host: "public.example", port: 443, addresses: ["93.184.216.34"] },
    });
    await expect(boundary.resolveEndpoint("private.example", 443)).resolves.toMatchObject({
      kind: "deny",
    });
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });

  it("accepts trusted TUN fake-IP DNS answers but never raw fake-IP literals", async () => {
    const resolveHost = vi.fn(async () => ["198.18.0.158"]);
    const boundary = new NetworkBoundary({ resolveHost });
    const ranges = ["198.18.0.0/15"];

    await expect(boundary.resolveEndpoint("dots.example", 443, ranges)).resolves.toEqual({
      kind: "allow",
      endpoint: { host: "dots.example", port: 443, addresses: ["198.18.0.158"] },
    });
    await expect(boundary.resolveEndpoint("198.18.0.158", 443, ranges)).resolves.toMatchObject({
      kind: "deny",
    });
    expect(resolveHost).toHaveBeenCalledOnce();
  });

  it("matches Codex local exceptions without treating a wildcard as exact", async () => {
    const resolveHost = vi.fn(async () => ["127.0.0.1"]);
    const boundary = new NetworkBoundary({ resolveHost });

    await expect(boundary.resolveEndpoint("127.0.0.1", 8080)).resolves.toMatchObject({
      kind: "deny",
    });
    await expect(
      boundary.resolveEndpoint("127.0.0.1", 8080, [], undefined, {
        allowExactLocalAllow: true,
      }),
    ).resolves.toEqual({
      kind: "allow",
      endpoint: { host: "127.0.0.1", port: 8080, addresses: ["127.0.0.1"] },
    });
    await expect(
      boundary.resolveEndpoint("localhost", 8080, [], undefined, {
        allowExactLocalAllow: true,
      }),
    ).resolves.toEqual({
      kind: "allow",
      endpoint: { host: "localhost", port: 8080, addresses: ["127.0.0.1"] },
    });
  });

  it("keeps every resolved localhost loopback candidate for an exact local allow", async () => {
    const boundary = new NetworkBoundary({
      resolveHost: async () => ["127.0.0.1", "::1", "127.0.0.1"],
    });

    await expect(
      boundary.resolveEndpoint("localhost", 8080, [], undefined, {
        allowExactLocalAllow: true,
      }),
    ).resolves.toEqual({
      kind: "allow",
      endpoint: { host: "localhost", port: 8080, addresses: ["127.0.0.1", "::1"] },
    });
  });

  it("does not turn an exact localhost allow into a public DNS allow", async () => {
    const boundary = new NetworkBoundary({ resolveHost: async () => ["93.184.216.34"] });

    await expect(
      boundary.resolveEndpoint("localhost", 8080, [], undefined, {
        allowExactLocalAllow: true,
      }),
    ).resolves.toMatchObject({ kind: "deny" });
  });

  it("keeps independent private-outbound eligibility in the coalescing identity without granting binding", async () => {
    let release!: (value: string[]) => void;
    const gate = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    const resolveHost = vi.fn(() => gate);
    const boundary = new NetworkBoundary({ resolveHost });
    const strict = boundary.resolveEndpoint("mixed.example", 443);
    const eligible = boundary.resolveEndpoint("mixed.example", 443, [], undefined, {
      allowPrivateTargets: true,
      allowLocalBinding: false,
    });
    expect(resolveHost).toHaveBeenCalledTimes(2);
    release(["93.184.216.34", "10.0.0.1"]);
    await expect(strict).resolves.toMatchObject({ kind: "deny" });
    await expect(eligible).resolves.toEqual({
      kind: "allow",
      endpoint: { host: "mixed.example", port: 443, addresses: ["93.184.216.34", "10.0.0.1"] },
    });
    await expect(
      boundary.resolveEndpoint("198.18.0.1", 443, [], undefined, { allowPrivateTargets: true }),
    ).resolves.toMatchObject({ kind: "allow" });
  });

  it("allows private DNS answers with legacy explicit local-binding mode", async () => {
    const resolveHost = vi.fn(async () => ["192.168.1.20"]);
    const boundary = new NetworkBoundary({ resolveHost });

    await expect(boundary.resolveEndpoint("router.example", 80)).resolves.toMatchObject({
      kind: "deny",
    });
    await expect(
      boundary.resolveEndpoint("router.example", 80, [], undefined, {
        allowLocalBinding: true,
      }),
    ).resolves.toEqual({
      kind: "allow",
      endpoint: { host: "router.example", port: 80, addresses: ["192.168.1.20"] },
    });
  });

  it("fails closed when a DNS response contains any untrusted address", async () => {
    const boundary = new NetworkBoundary({
      resolveHost: async () => ["93.184.216.34", "10.0.0.1"],
    });
    await expect(boundary.resolveEndpoint("mixed.example", 443)).resolves.toMatchObject({
      kind: "deny",
    });
  });

  it("freezes every distinct safe DNS candidate in resolver order", async () => {
    const answers = ["93.184.216.34", "2001:4860:4860::8888", "93.184.216.34"];
    const boundary = new NetworkBoundary({ resolveHost: async () => answers });

    const decision = await boundary.resolveEndpoint("multi.example", 443);

    expect(decision).toEqual({
      kind: "allow",
      endpoint: {
        host: "multi.example",
        port: 443,
        addresses: ["93.184.216.34", "2001:4860:4860::8888"],
      },
    });
    if (decision.kind !== "allow") throw new Error("expected an allowed endpoint");
    expect(Object.isFrozen(decision.endpoint)).toBe(true);
    expect(Object.isFrozen(decision.endpoint.addresses)).toBe(true);

    answers[0] = "10.0.0.1";
    expect(decision.endpoint.addresses).toEqual(["93.184.216.34", "2001:4860:4860::8888"]);
  });

  it("retains all trusted TUN candidates without a second DNS lookup", async () => {
    const resolveHost = vi.fn(async () => ["198.18.0.158", "198.18.0.159", "198.18.0.158"]);
    const boundary = new NetworkBoundary({ resolveHost });

    await expect(boundary.resolveEndpoint("dots.example", 443, ["198.18.0.0/15"])).resolves.toEqual(
      {
        kind: "allow",
        endpoint: {
          host: "dots.example",
          port: 443,
          addresses: ["198.18.0.158", "198.18.0.159"],
        },
      },
    );
    expect(resolveHost).toHaveBeenCalledOnce();
  });

  it("coalesces DNS work while isolating caller aborts and range fingerprints", async () => {
    const releases: Array<(value: readonly string[]) => void> = [];
    const resolveHost = vi.fn(
      () =>
        new Promise<readonly string[]>((resolve) => {
          releases.push(resolve);
        }),
    );
    const boundary = new NetworkBoundary({ resolveHost });
    const aborted = new AbortController();
    const first = boundary.resolveEndpoint("coalesced.example", 443, [], aborted.signal);
    const second = boundary.resolveEndpoint("coalesced.example", 443);
    const differentRange = boundary.resolveEndpoint("coalesced.example", 443, ["198.18.0.0/15"]);

    aborted.abort();
    await expect(first).resolves.toMatchObject({ kind: "deny" });
    expect(resolveHost).toHaveBeenCalledTimes(2);
    releases[0]?.(["93.184.216.34"]);
    await expect(second).resolves.toMatchObject({ kind: "allow" });
    releases[1]?.(["93.184.216.34"]);
    await expect(differentRange).resolves.toMatchObject({ kind: "allow" });
  });

  it("fails closed on DNS failure and malformed endpoints", async () => {
    const boundary = new NetworkBoundary({
      resolveHost: async () => {
        throw new Error("resolver unavailable");
      },
    });
    await expect(boundary.resolveEndpoint("failure.example", 443)).resolves.toMatchObject({
      kind: "deny",
    });
    await expect(boundary.resolveEndpoint("failure.example", 0)).resolves.toMatchObject({
      kind: "deny",
    });
  });
});
