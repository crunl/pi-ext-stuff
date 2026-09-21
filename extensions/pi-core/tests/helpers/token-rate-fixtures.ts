/** Shared fixtures for token-rate tests: an assistant message with a
 * realistic shape (pi-ai AssistantMessage) and a text-delta update event. */
export function assistantMessage(text: string, output = 0) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    usage: {
      input: 0,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    api: "openai-completions" as const,
    provider: "test",
    model: "test-model",
    stopReason: "stop" as const,
    timestamp: 0,
  };
}

export function messageUpdate(message: ReturnType<typeof assistantMessage>, delta: string) {
  return {
    type: "message_update" as const,
    message,
    assistantMessageEvent: {
      type: "text_delta" as const,
      contentIndex: 0,
      delta,
      partial: message,
    },
  };
}
