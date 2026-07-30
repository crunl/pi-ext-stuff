import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AUTO_REVIEW_SYSTEM_PROMPT } from "../src/auto-review-request.ts";
import { GuardianReviewSessionManager, type GuardianSessionKey } from "../src/guardian-session.ts";

const key: GuardianSessionKey = {
  cwd: "/workspace/project",
  configFingerprint: "config-a",
  provider: "openai-codex",
  model: "guardian",
};

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function fixedLength(prefix: string, length: number): string {
  return `${prefix}${"x".repeat(length - prefix.length)}`;
}

describe("GuardianReviewSessionManager", () => {
  it("reuses an idle trunk while isolating a concurrent fork", () => {
    const manager = new GuardianReviewSessionManager();
    const first = manager.open(key, "first approval");
    const concurrent = manager.open(key, "second approval");

    expect(concurrent.sessionId.replace(/-fork-.+$/, "")).toBe(first.sessionId);
    expect(messageText(first.context.messages.at(-1)!)).toContain("first approval");
    expect(messageText(concurrent.context.messages.at(-1)!)).toContain("second approval");
    expect(first.context).toMatchObject({
      systemPrompt: AUTO_REVIEW_SYSTEM_PROMPT,
      messages: [expect.objectContaining({ role: "user" })],
    });
    expect(first.context.tools).toBeUndefined();
    expect(Object.isFrozen(first.context)).toBe(true);
    expect(Object.isFrozen(first.context.messages)).toBe(true);

    concurrent.commit('{"outcome":"deny"}');
    concurrent.release();

    const whileTrunkActive = manager.open(key, "third concurrent approval");
    expect(whileTrunkActive.sessionId.replace(/-fork-.+$/, "")).toBe(first.sessionId);

    first.commit('{"outcome":"allow"}');
    const latestSnapshotFork = manager.open(key, "latest snapshot approval");
    const forkSnapshotText = latestSnapshotFork.context.messages.map(messageText).join("\n");
    expect(forkSnapshotText).toContain("first approval");
    expect(forkSnapshotText).toContain('{"outcome":"allow"}');

    first.release();
    whileTrunkActive.release();
    latestSnapshotFork.release();

    const next = manager.open(key, "next approval");
    const retainedText = next.context.messages.map(messageText).join("\n");
    expect(next.sessionId).toBe(first.sessionId);
    expect(next.context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(retainedText).toContain("first approval");
    expect(retainedText).toContain('{"outcome":"allow"}');
    expect(retainedText).not.toContain("second approval");
    expect(retainedText).not.toContain('{"outcome":"deny"}');
    expect(retainedText).not.toContain("third concurrent approval");
    expect(retainedText).not.toContain("latest snapshot approval");
  });

  it.each([
    ["cwd", "/workspace/other"],
    ["configFingerprint", "config-b"],
    ["provider", "anthropic"],
    ["model", "guardian-v2"],
  ] satisfies Array<[keyof GuardianSessionKey, string]>)(
    "creates a fresh trunk when %s changes",
    (field, value) => {
      const manager = new GuardianReviewSessionManager();
      const first = manager.open(key, "first approval");
      first.commit('{"outcome":"allow"}');
      first.release();

      const changed = manager.open({ ...key, [field]: value }, "changed approval");

      expect(changed.sessionId).not.toBe(first.sessionId);
      expect(changed.context.messages.map(messageText)).toEqual(["changed approval"]);
    },
  );

  it("invalidates committed history", () => {
    const manager = new GuardianReviewSessionManager();
    const first = manager.open(key, "old approval");
    first.commit('{"outcome":"allow"}');
    first.release();

    manager.invalidate();
    const next = manager.open(key, "new approval");

    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.context.messages.map(messageText)).toEqual(["new approval"]);
  });

  it("keeps an invalidated active lease from mutating or releasing its replacement", () => {
    const manager = new GuardianReviewSessionManager();
    const stale = manager.open(key, "stale approval");

    manager.invalidate();
    const replacement = manager.open(key, "replacement approval");
    stale.commit('{"outcome":"stale"}');
    stale.release();

    const concurrent = manager.open(key, "replacement concurrent approval");
    expect(concurrent.sessionId.replace(/-fork-.+$/, "")).toBe(replacement.sessionId);

    replacement.commit('{"outcome":"fresh"}');
    replacement.release();
    concurrent.commit('{"outcome":"fork"}');
    concurrent.release();

    const next = manager.open(key, "next approval");
    const retainedText = next.context.messages.map(messageText).join("\n");
    expect(retainedText).toContain("replacement approval");
    expect(retainedText).toContain('{"outcome":"fresh"}');
    expect(retainedText).not.toContain("stale approval");
    expect(retainedText).not.toContain('{"outcome":"stale"}');
    expect(retainedText).not.toContain("replacement concurrent approval");
    expect(retainedText).not.toContain('{"outcome":"fork"}');
  });

  it("makes commit and release idempotent and ignores commit after release", () => {
    const manager = new GuardianReviewSessionManager();
    const lease = manager.open(key, "idempotent approval");
    const originalMessages = [...lease.context.messages];

    lease.commit('{"outcome":"first"}');
    lease.commit('{"outcome":"second"}');
    lease.release();
    lease.release();
    lease.commit('{"outcome":"after-release"}');

    expect(lease.context.messages).toEqual(originalMessages);

    const releasedBeforeCommit = manager.open(key, "released before commit");
    releasedBeforeCommit.release();
    releasedBeforeCommit.commit('{"outcome":"late"}');

    const next = manager.open(key, "next approval");
    const retainedText = next.context.messages.map(messageText).join("\n");
    expect(retainedText.match(/idempotent approval/g)).toHaveLength(1);
    expect(retainedText.match(/\{"outcome":"first"\}/g)).toHaveLength(1);
    expect(retainedText).not.toContain('{"outcome":"second"}');
    expect(retainedText).not.toContain('{"outcome":"after-release"}');
    expect(retainedText).not.toContain("released before commit");
    expect(retainedText).not.toContain('{"outcome":"late"}');
  });

  it("retains at most eight complete request and response pairs", () => {
    const manager = new GuardianReviewSessionManager();

    for (let index = 0; index < 10; index += 1) {
      const lease = manager.open(key, `request[${index}]`);
      lease.commit(`response[${index}]`);
      lease.release();
    }

    const next = manager.open(key, "current request");
    const retained = next.context.messages.slice(0, -1);
    expect(retained).toHaveLength(16);
    expect(retained.map((message) => message.role)).toEqual(
      Array.from({ length: 8 }, () => ["user", "assistant"]).flat(),
    );
    expect(retained.map(messageText)).toEqual(
      Array.from({ length: 8 }, (_, offset) => {
        const index = offset + 2;
        return [`request[${index}]`, `response[${index}]`];
      }).flat(),
    );
  });

  it("retains newest complete pairs within the 24,000-character bound", () => {
    const manager = new GuardianReviewSessionManager();

    for (let index = 0; index < 3; index += 1) {
      const lease = manager.open(key, fixedLength(`request[${index}]`, 6_000));
      lease.commit(fixedLength(`response[${index}]`, 4_000));
      lease.release();
    }

    const next = manager.open(key, "current request");
    const retained = next.context.messages.slice(0, -1);
    const retainedText = retained.map(messageText);
    expect(retained).toHaveLength(4);
    expect(retainedText.reduce((total, content) => total + content.length, 0)).toBe(20_000);
    expect(retainedText[0]).toContain("request[1]");
    expect(retainedText[2]).toContain("request[2]");
    expect(retainedText.join("\n")).not.toContain("request[0]");
  });

  it("drops a completed pair that alone exceeds the character bound", () => {
    const manager = new GuardianReviewSessionManager();
    const oversized = manager.open(key, fixedLength("oversized request", 12_001));
    oversized.commit(fixedLength("oversized response", 12_000));
    oversized.release();

    const next = manager.open(key, "current request");

    expect(next.context.messages.map(messageText)).toEqual(["current request"]);
  });
});
