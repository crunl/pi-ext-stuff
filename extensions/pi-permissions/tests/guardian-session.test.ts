import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AUTO_REVIEW_SYSTEM_PROMPT } from "../src/auto-review-request.ts";
import { GuardianReviewSessionManager, type GuardianSessionKey } from "../src/guardian-session.ts";

const key: GuardianSessionKey = {
  sessionId: "session-a",
  cwd: "/workspace/project",
  configFingerprint: "config-a",
  provider: "openai-codex",
  model: "guardian",
  reasoningEffort: "medium",
  toolFingerprint: "tools-a",
};

const guardianTools = [
  {
    name: "read",
    description: "Read a file",
    parameters: Type.Object({ path: Type.String() }),
  },
];

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
    const first = manager.open(key, "first approval", guardianTools);
    const concurrent = manager.open(key, "second approval", guardianTools);

    expect(concurrent.sessionId.replace(/-fork-.+$/, "")).toBe(first.sessionId);
    expect(messageText(first.context.messages.at(-1)!)).toContain("first approval");
    expect(messageText(concurrent.context.messages.at(-1)!)).toContain("second approval");
    expect(first.context).toMatchObject({
      systemPrompt: AUTO_REVIEW_SYSTEM_PROMPT,
      messages: [expect.objectContaining({ role: "user" })],
    });
    expect(first.context.tools?.map((tool) => tool.name)).toEqual(["read"]);
    expect(Object.isFrozen(first.context.tools)).toBe(true);
    expect(Object.isFrozen(first.context)).toBe(true);
    expect(Object.isFrozen(first.context.messages)).toBe(true);

    concurrent.commit([assistant('{"outcome":"deny"}')]);
    concurrent.release();

    const whileTrunkActive = manager.open(key, "third concurrent approval");
    expect(whileTrunkActive.sessionId.replace(/-fork-.+$/, "")).toBe(first.sessionId);

    first.commit([assistant('{"outcome":"allow"}')]);
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

  it("extends a lease with assistant tool calls and tool results without committing the fork", () => {
    const manager = new GuardianReviewSessionManager();
    const first = manager.open(key, "first approval", guardianTools);
    const firstToolCall = assistantToolCall("tool-call-1", "read");
    const firstToolResult = toolResult("tool-call-1", "read", "first evidence");

    const extended = first.extend([firstToolCall, firstToolResult]);

    expect(extended).not.toBe(first.context);
    expect(extended.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(messageText(extended.messages.at(-1)!)).toBe("first evidence");
    expect(Object.isFrozen(extended)).toBe(true);
    expect(Object.isFrozen(extended.messages)).toBe(true);

    const concurrent = manager.open(key, "fork approval", guardianTools);
    concurrent.commit([
      assistantToolCall("fork-tool-call", "read"),
      toolResult("fork-tool-call", "read", "fork evidence"),
      assistant('{"outcome":"deny"}'),
    ]);
    concurrent.release();

    first.commit([firstToolCall, firstToolResult, assistant('{"outcome":"allow"}')]);
    first.release();

    const next = manager.open(key, "next approval", guardianTools);
    const retainedText = next.context.messages.map(messageText).join("\n");
    expect(retainedText).toContain("first evidence");
    expect(retainedText).toContain('{"outcome":"allow"}');
    expect(retainedText).not.toContain("fork evidence");
    next.release();
  });

  it.each([
    ["cwd", "/workspace/other"],
    ["configFingerprint", "config-b"],
    ["provider", "anthropic"],
    ["model", "guardian-v2"],
    ["sessionId", "session-b"],
    ["reasoningEffort", "high"],
    ["toolFingerprint", "tools-b"],
  ] satisfies Array<[keyof GuardianSessionKey, string]>)(
    "creates a fresh trunk when %s changes",
    (field, value) => {
      const manager = new GuardianReviewSessionManager();
      const first = manager.open(key, "first approval");
      first.commit([assistant('{"outcome":"allow"}')]);
      first.release();

      const changed = manager.open({ ...key, [field]: value }, "changed approval");

      expect(changed.sessionId).not.toBe(first.sessionId);
      expect(changed.context.messages.map(messageText)).toEqual(["changed approval"]);
    },
  );

  it("invalidates committed history", () => {
    const manager = new GuardianReviewSessionManager();
    const first = manager.open(key, "old approval");
    first.commit([assistant('{"outcome":"allow"}')]);
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
    stale.commit([assistant('{"outcome":"stale"}')]);
    stale.release();

    const concurrent = manager.open(key, "replacement concurrent approval");
    expect(concurrent.sessionId.replace(/-fork-.+$/, "")).toBe(replacement.sessionId);

    replacement.commit([assistant('{"outcome":"fresh"}')]);
    replacement.release();
    concurrent.commit([assistant('{"outcome":"fork"}')]);
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

    lease.commit([assistant('{"outcome":"first"}')]);
    lease.commit([assistant('{"outcome":"second"}')]);
    lease.release();
    lease.release();
    lease.commit([assistant('{"outcome":"after-release"}')]);

    expect(lease.context.messages).toEqual(originalMessages);

    const releasedBeforeCommit = manager.open(key, "released before commit");
    releasedBeforeCommit.release();
    releasedBeforeCommit.commit([assistant('{"outcome":"late"}')]);

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
      lease.commit([assistant(`response[${index}]`)]);
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
      lease.commit([assistant(fixedLength(`response[${index}]`, 4_000))]);
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
    oversized.commit([assistant(fixedLength("oversized response", 12_000))]);
    oversized.release();

    const next = manager.open(key, "current request");

    expect(next.context.messages.map(messageText)).toEqual(["current request"]);
  });

  it("counts tool-call arguments against the history character bound", () => {
    const manager = new GuardianReviewSessionManager();
    const oversized = manager.open(key, "oversized tool request");
    oversized.commit([
      {
        ...assistantToolCall("oversized-tool", "read"),
        content: [
          {
            type: "toolCall",
            id: "oversized-tool",
            name: "read",
            arguments: { path: "x".repeat(24_000) },
          },
        ],
      },
    ]);
    oversized.release();

    const next = manager.open(key, "current request");

    expect(next.context.messages.map(messageText)).toEqual(["current request"]);
  });
});

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: key.provider,
    provider: key.provider,
    model: key.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function assistantToolCall(id: string, name: string): AssistantMessage {
  return {
    ...assistant(""),
    content: [{ type: "toolCall", id, name, arguments: { path: "README.md" } }],
    stopReason: "toolUse",
  };
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}
