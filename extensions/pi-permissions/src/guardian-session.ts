import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context, Message, UserMessage } from "@earendil-works/pi-ai";
import { AUTO_REVIEW_SYSTEM_PROMPT } from "./auto-review-request.ts";

const MAX_HISTORY_PAIRS = 8;
const MAX_HISTORY_CHARACTERS = 24_000;

export interface GuardianSessionKey {
  cwd: string;
  configFingerprint: string;
  provider: string;
  model: string;
}

export interface GuardianReviewLease {
  readonly context: Context;
  readonly sessionId: string;
  commit(assistantText: string): void;
  release(): void;
}

type Trunk = {
  key: GuardianSessionKey;
  sessionId: string;
  active: boolean;
  history: Message[];
};

function keysMatch(left: GuardianSessionKey, right: GuardianSessionKey): boolean {
  return (
    left.cwd === right.cwd &&
    left.configFingerprint === right.configFingerprint &&
    left.provider === right.provider &&
    left.model === right.model
  );
}

function messageCharacters(message: Message): number {
  if (typeof message.content === "string") return message.content.length;
  return message.content.reduce((total, part) => {
    if (part.type === "text") return total + part.text.length;
    if (part.type === "thinking") return total + part.thinking.length;
    return total;
  }, 0);
}

function trimHistory(history: Message[]): Message[] {
  let firstRetainedIndex = history.length;
  let retainedPairs = 0;
  let retainedCharacters = 0;

  for (let index = history.length - 2; index >= 0; index -= 2) {
    const request = history[index];
    const response = history[index + 1];
    if (!request || !response) break;
    const pairCharacters = messageCharacters(request) + messageCharacters(response);
    if (
      retainedPairs >= MAX_HISTORY_PAIRS ||
      retainedCharacters + pairCharacters > MAX_HISTORY_CHARACTERS
    ) {
      break;
    }
    firstRetainedIndex = index;
    retainedPairs += 1;
    retainedCharacters += pairCharacters;
  }

  return history.slice(firstRetainedIndex);
}

function cloneMessage(message: Message): Message {
  return structuredClone(message);
}

function freezeMessage(message: Message): Message {
  if (Array.isArray(message.content)) {
    for (const part of message.content) Object.freeze(part);
    Object.freeze(message.content);
  }
  if (message.role === "assistant") {
    Object.freeze(message.usage.cost);
    Object.freeze(message.usage);
  }
  return Object.freeze(message);
}

function createUserMessage(requestPrompt: string): UserMessage {
  return {
    role: "user",
    content: requestPrompt,
    timestamp: Date.now(),
  };
}

function createAssistantMessage(key: GuardianSessionKey, assistantText: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: assistantText }],
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

function createContext(snapshot: Message[], request: UserMessage): Context {
  const messages = [...snapshot.map(cloneMessage), request].map(freezeMessage);
  Object.freeze(messages);
  return Object.freeze({
    systemPrompt: AUTO_REVIEW_SYSTEM_PROMPT,
    messages,
  });
}

export class GuardianReviewSessionManager {
  private trunk?: Trunk;

  open(key: GuardianSessionKey, requestPrompt: string): GuardianReviewLease {
    if (!this.trunk || !keysMatch(this.trunk.key, key)) {
      this.trunk = {
        key: { ...key },
        sessionId: `pi-permissions-guardian-${randomUUID()}`,
        active: false,
        history: [],
      };
    }

    const trunk = this.trunk;
    const isFork = trunk.active;
    if (!isFork) trunk.active = true;

    const request = createUserMessage(requestPrompt);
    const context = createContext(trunk.history, request);
    const sessionId = isFork ? `${trunk.sessionId}-fork-${randomUUID()}` : trunk.sessionId;
    let committed = false;
    let released = false;

    return {
      context,
      sessionId,
      commit: (assistantText) => {
        if (committed || released) return;
        committed = true;
        if (isFork || this.trunk !== trunk) return;
        trunk.history = trimHistory([
          ...trunk.history,
          request,
          createAssistantMessage(trunk.key, assistantText),
        ]);
      },
      release: () => {
        if (released) return;
        released = true;
        if (!isFork && this.trunk === trunk) trunk.active = false;
      },
    };
  }

  invalidate(): void {
    this.trunk = undefined;
  }
}
