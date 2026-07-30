import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

const homebrewPi = realpathSync("/opt/homebrew/bin/pi");
const homebrewPrefix = dirname(dirname(homebrewPi));
const agentLoopPath = join(
  homebrewPrefix,
  "libexec/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
  "@earendil-works/pi-agent-core/dist/agent-loop.js",
);

function assistantMessage(content: unknown[], stopReason: "toolUse" | "stop") {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function response(message: ReturnType<typeof assistantMessage>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: message.stopReason, message };
    },
    result: async () => message,
  };
}

const describeCoreRegression =
  process.env.PI_PERMISSIONS_CORE_REGRESSION === "1" ? describe : describe.skip;

describeCoreRegression("Homebrew pi-agent-core execution abort gate", () => {
  it("does not invoke an abort-ignorant prepared tool after a later preflight aborts", async () => {
    const { runAgentLoop } = await import(`${pathToFileURL(agentLoopPath).href}?regression=1`);
    const abortController = new AbortController();
    let executions = 0;
    let streamCall = 0;
    const toolCalls = [
      { type: "toolCall", id: "prepared-first", name: "unsafe", arguments: {} },
      { type: "toolCall", id: "aborts-batch", name: "unsafe", arguments: {} },
    ];
    const first = assistantMessage(toolCalls, "toolUse");
    const last = assistantMessage([{ type: "text", text: "done" }], "stop");

    const messages = await runAgentLoop(
      [{ role: "user", content: "test", timestamp: Date.now() }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            name: "unsafe",
            label: "unsafe",
            description: "abort-ignorant test tool",
            parameters: Type.Object({}),
            execute: async () => {
              executions += 1;
              return { content: [{ type: "text", text: "executed" }], details: {} };
            },
          },
        ],
      },
      {
        model: { provider: "test", id: "test", api: "test" },
        convertToLlm: (input: unknown[]) => input,
        toolExecution: "parallel",
        beforeToolCall: async ({ toolCall }: { toolCall: { id: string } }) => {
          if (toolCall.id === "aborts-batch") abortController.abort();
        },
      },
      async () => undefined,
      abortController.signal,
      async () => response(streamCall++ === 0 ? first : last),
    );

    expect(executions).toBe(0);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "prepared-first",
          isError: true,
          content: [{ type: "text", text: "Operation aborted" }],
        }),
      ]),
    );
  });
});
