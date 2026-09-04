import { describe, expect, it } from "vitest";
import {
  createAuditLink,
  createDelegationPlan,
  intersectSandboxPolicy,
  isEnvelopeSubset,
  isNetworkCovered,
  isWriteCovered,
  resolveChildEnvelope,
} from "../src/delegation.ts";
import type { SandboxPolicy } from "../src/sandbox.ts";

function basePolicy(): SandboxPolicy {
  return {
    filesystem: {
      allowWrite: ["/proj", "/proj/sub", "/other"],
      denyRead: ["/proj/secret"],
      denyWrite: ["/proj/secret"],
    },
    network: {
      allowedDomains: ["example.com", "api.example.com"],
      deniedDomains: ["evil.example"],
    },
  };
}

describe("DelegationPlan", () => {
  it("creates a leaf-by-default plan with normalized envelope", () => {
    const plan = createDelegationPlan({
      envelope: { writeRoots: ["/proj/sub", "/proj"], networkHosts: ["Example.COM "] },
      parentTurnId: 1,
      parentSessionId: "s1",
    });
    expect(plan.maxDepth).toBe(1);
    expect(plan.noReDelegate).toBe(true);
    expect(plan.envelope.writeRoots).toEqual(["/proj", "/proj/sub"]);
    expect(plan.envelope.networkHosts).toEqual(["example.com"]);
  });

  it("rejects negative maxDepth and empty session", () => {
    expect(() =>
      createDelegationPlan({
        envelope: { writeRoots: [], networkHosts: [] },
        parentTurnId: 1,
        parentSessionId: "",
      }),
    ).toThrow();
    expect(() =>
      createDelegationPlan({
        envelope: { writeRoots: [], networkHosts: [] },
        parentTurnId: 1,
        parentSessionId: "s1",
        maxDepth: -1,
      }),
    ).toThrow();
  });

  it("enforces subset narrowing for child envelopes", () => {
    const parent = { writeRoots: ["/proj"], networkHosts: ["example.com"] };
    expect(isEnvelopeSubset({ writeRoots: ["/proj/sub"], networkHosts: [] }, parent)).toBe(true);
    expect(isEnvelopeSubset({ writeRoots: ["/proj"], networkHosts: [] }, parent)).toBe(true);
    expect(isEnvelopeSubset({ writeRoots: ["/other"], networkHosts: [] }, parent)).toBe(false);
    expect(isEnvelopeSubset({ writeRoots: ["/proj2"], networkHosts: [] }, parent)).toBe(false);
    expect(
      isEnvelopeSubset({ writeRoots: ["/proj"], networkHosts: [], allowReDelegate: true }, parent),
    ).toBe(false);
  });

  it("rejects relative envelope roots", () => {
    expect(() =>
      createDelegationPlan({
        envelope: { writeRoots: ["relative/path"], networkHosts: [] },
        parentTurnId: 1,
        parentSessionId: "s1",
      }),
    ).toThrow(/absolute/);
  });

  it("intersects sandbox policy with envelope (deny lists preserved)", () => {
    const child = intersectSandboxPolicy(basePolicy(), {
      writeRoots: ["/proj"],
      networkHosts: ["example.com"],
    });
    expect(child.filesystem.allowWrite).toEqual(["/proj", "/proj/sub"]);
    expect(child.filesystem.denyRead).toEqual(["/proj/secret"]);
    expect(child.filesystem.denyWrite).toEqual(["/proj/secret"]);
    expect(child.network.allowedDomains).toEqual(["example.com"]);
    expect(child.network.deniedDomains).toEqual(["evil.example"]);
  });

  it("resolves the child envelope by inheriting empty configured lists", () => {
    const { envelope, remainingDepth } = resolveChildEnvelope({
      configuredWriteRoots: [],
      configuredNetworkHosts: [],
      allowReDelegate: true,
      parentBase: basePolicy(),
      parentRemainingDepth: 8,
      childCwd: "/proj",
    });
    expect([...envelope.writeRoots].sort()).toEqual(["/other", "/proj", "/proj/sub"]);
    expect([...envelope.networkHosts].sort()).toEqual(["api.example.com", "example.com"]);
    expect(remainingDepth).toBe(7);
  });

  it("narrows configured roots to parent-covered entries", () => {
    const { envelope } = resolveChildEnvelope({
      configuredWriteRoots: ["/proj/sub", "/elsewhere"],
      configuredNetworkHosts: ["example.com", "unknown.example"],
      allowReDelegate: false,
      parentBase: basePolicy(),
      parentRemainingDepth: 3,
      childCwd: "/proj",
    });
    expect(envelope.writeRoots).toEqual(["/proj/sub"]);
    expect(envelope.networkHosts).toEqual(["example.com"]);
    expect(envelope.allowReDelegate).toBe(false);
  });

  it("resolves relative configured roots against the child cwd", () => {
    const { envelope } = resolveChildEnvelope({
      configuredWriteRoots: ["sub"],
      configuredNetworkHosts: [],
      allowReDelegate: true,
      parentBase: undefined,
      parentRemainingDepth: 2,
      childCwd: "/proj",
    });
    expect(envelope.writeRoots).toEqual(["/proj/sub"]);
  });

  it("floors remaining depth at zero", () => {
    const { remainingDepth } = resolveChildEnvelope({
      configuredWriteRoots: [],
      configuredNetworkHosts: [],
      allowReDelegate: true,
      parentBase: basePolicy(),
      parentRemainingDepth: 0,
      childCwd: "/proj",
    });
    expect(remainingDepth).toBe(0);
  });

  it("covers nested writes but not path siblings", () => {
    const envelope = { writeRoots: ["/proj"], networkHosts: [] as string[] };
    expect(isWriteCovered("/proj", envelope)).toBe(true);
    expect(isWriteCovered("/proj/a/b", envelope)).toBe(true);
    expect(isWriteCovered("/proj2", envelope)).toBe(false);
    expect(isWriteCovered("/other", envelope)).toBe(false);
  });

  it("matches envelope hosts case-insensitively", () => {
    const envelope = { writeRoots: [] as string[], networkHosts: ["Example.COM"] };
    expect(isNetworkCovered("example.com", envelope)).toBe(true);
    expect(isNetworkCovered("EXAMPLE.com ", envelope)).toBe(true);
    expect(isNetworkCovered("evil.example", envelope)).toBe(false);
  });

  it("reports configured entries dropped outside the parent policy", () => {
    const resolved = resolveChildEnvelope({
      configuredWriteRoots: ["/proj/sub", "/elsewhere"],
      configuredNetworkHosts: ["example.com", "unknown.example"],
      allowReDelegate: true,
      parentBase: basePolicy(),
      parentRemainingDepth: 2,
      childCwd: "/proj",
    });
    expect(resolved.envelope.writeRoots).toEqual(["/proj/sub"]);
    expect(resolved.droppedWriteRoots).toEqual(["/elsewhere"]);
    expect(resolved.droppedNetworkHosts).toEqual(["unknown.example"]);
  });

  it("matches wildcard and port-qualified envelope patterns", () => {
    const envelope = {
      writeRoots: [] as string[],
      networkHosts: ["*.example.com", "db.internal:5432"],
    };
    expect(isNetworkCovered("api.example.com", envelope)).toBe(true);
    expect(isNetworkCovered("example.com", envelope)).toBe(false);
    expect(isNetworkCovered("db.internal", envelope, 5432)).toBe(true);
    expect(isNetworkCovered("db.internal", envelope, 5433)).toBe(false);
    expect(isNetworkCovered("db.internal", envelope)).toBe(false);
    expect(isNetworkCovered("evil.example", envelope)).toBe(false);
  });

  it("creates an audit link binding parent to child", () => {
    const envelope = { writeRoots: ["/proj"], networkHosts: [] as string[] };
    const link = createAuditLink({
      parentSessionId: "s1",
      parentTurnId: 1,
      childTurnId: 2,
      envelope,
    });
    expect(link.parentTurnId).toBe(1);
    expect(link.childTurnId).toBe(2);
    expect(link.envelope).toBe(envelope);
  });
});
