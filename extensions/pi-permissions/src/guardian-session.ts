import { randomUUID } from "node:crypto";
import type { Context, Message, Tool, UserMessage } from "@earendil-works/pi-ai";
import { AUTO_REVIEW_SYSTEM_PROMPT } from "./auto-review-request.ts";

const MAX_HISTORY_PAIRS = 8;
const MAX_HISTORY_CHARACTERS = 24_000;

export interface GuardianSessionKey {
  sessionId: string;
  cwd: string;
  configFingerprint: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  toolFingerprint: string;
}

export interface GuardianReviewLease {
  readonly context: Context;
  readonly sessionId: string;
  extend(messages: Message[]): Context;
  commit(messages: Message[]): void;
  release(): void;
}

type Trunk = {
  key: GuardianSessionKey;
  systemPrompt: string;
  sessionId: string;
  active: boolean;
  turns: Message[][];
};

function keysMatch(left: GuardianSessionKey, right: GuardianSessionKey): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.cwd === right.cwd &&
    left.configFingerprint === right.configFingerprint &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.toolFingerprint === right.toolFingerprint
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

function turnCharacters(turn: Message[]): number {
  return turn.reduce((total, message) => total + messageCharacters(message), 0);
}

function trimTurns(turns: Message[][]): Message[][] {
  let firstRetainedIndex = turns.length;
  let retainedTurns = 0;
  let retainedCharacters = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const characters = turnCharacters(turn);
    if (
      retainedTurns >= MAX_HISTORY_PAIRS ||
      retainedCharacters + characters > MAX_HISTORY_CHARACTERS
    ) {
      break;
    }
    firstRetainedIndex = index;
    retainedTurns += 1;
    retainedCharacters += characters;
  }

  return turns.slice(firstRetainedIndex).map((turn) => turn.map(cloneMessage));
}

function cloneMessage(message: Message): Message {
  return structuredClone(message);
}

function freezeMessage(message: Message): Message {
  if (Array.isArray(message.content)) {
    for (const part of message.content) Object.freeze(part);
    Object.freeze(message.content);
  }
  if (message.role === "assistant" && message.usage) {
    Object.freeze(message.usage.cost);
    Object.freeze(message.usage);
  }
  return Object.freeze(message);
}

function cloneTool(tool: Tool): Tool {
  return Object.freeze({ ...tool });
}

function createUserMessage(requestPrompt: string): UserMessage {
  return {
    role: "user",
    content: requestPrompt,
    timestamp: Date.now(),
  };
}

function createContext(
  messages: Message[],
  tools: Tool[] | undefined,
  systemPrompt: string,
): Context {
  const frozenMessages = messages.map(cloneMessage).map(freezeMessage);
  Object.freeze(frozenMessages);
  const frozenTools = tools?.map(cloneTool);
  if (frozenTools) Object.freeze(frozenTools);
  return Object.freeze({
    systemPrompt,
    messages: frozenMessages,
    ...(frozenTools === undefined ? {} : { tools: frozenTools }),
  });
}

function createLeaseContext(
  snapshot: Message[],
  request: UserMessage,
  tools: Tool[] | undefined,
  systemPrompt: string,
): Context {
  const messages = [...snapshot, request];
  Object.freeze(messages);
  return createContext(messages, tools, systemPrompt);
}

export class GuardianReviewSessionManager {
  private trunk?: Trunk;

  open(
    key: GuardianSessionKey,
    requestPrompt: string,
    tools?: Tool[],
    systemPrompt = AUTO_REVIEW_SYSTEM_PROMPT,
  ): GuardianReviewLease {
    if (
      !this.trunk ||
      !keysMatch(this.trunk.key, key) ||
      this.trunk.systemPrompt !== systemPrompt
    ) {
      this.trunk = {
        key: { ...key },
        systemPrompt,
        sessionId: `pi-permissions-guardian-${randomUUID()}`,
        active: false,
        turns: [],
      };
    }

    const trunk = this.trunk;
    const isFork = trunk.active;
    if (!isFork) trunk.active = true;

    const request = createUserMessage(requestPrompt);
    const snapshot = trimTurns(trunk.turns).flat();
    const context = createLeaseContext(snapshot, request, tools, trunk.systemPrompt);
    const sessionId = isFork ? `${trunk.sessionId}-fork-${randomUUID()}` : trunk.sessionId;
    let committed = false;
    let released = false;

    return {
      context,
      sessionId,
      extend: (messages) => {
        return createContext([...context.messages, ...messages], tools, trunk.systemPrompt);
      },
      commit: (messages) => {
        if (committed || released) return;
        committed = true;
        if (isFork || this.trunk !== trunk) return;
        trunk.turns = trimTurns([...trunk.turns, [request, ...messages]]);
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
