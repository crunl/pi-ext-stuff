import { randomUUID } from "node:crypto";
import type { Context, Message, Tool, UserMessage } from "@earendil-works/pi-ai";
import {
  AUTO_REVIEW_SYSTEM_PROMPT,
  renderAutoReviewPrompt,
  renderDeltaReviewPrompt,
} from "./auto-review-request.ts";
import type { GuardianTranscriptEntry } from "./guardian-transcript.ts";
import {
  boundGuardianTranscriptDelta,
  sliceGuardianTranscriptFrom,
} from "./guardian-transcript.ts";

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

export interface GuardianTranscriptCursor {
  epoch: number;
  seenCount: number;
}

export interface GuardianReviewLease {
  readonly context: Context;
  readonly sessionId: string;
  readonly cursorUsed: GuardianTranscriptCursor | undefined;
  readonly newCursor: GuardianTranscriptCursor;
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
  lastCursor?: GuardianTranscriptCursor;
  priorReviewCount: number;
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
    if (part.type === "toolCall") {
      // Tool-call arguments are model-controlled context too. Count their
      // serialized identity so a large read path or query cannot bypass the
      // bounded Guardian trunk merely by using a non-text content block.
      try {
        return total + JSON.stringify(part).length;
      } catch {
        // An un-serializable tool call cannot be safely budgeted; treat it as
        // larger than the entire history budget and drop that turn.
        return total + MAX_HISTORY_CHARACTERS + 1;
      }
    }
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

export interface GuardianTranscriptMeta {
  epoch: number;
  rawEntries: readonly GuardianTranscriptEntry[];
  /** Action + permission context for the Delta prompt body. */
  action: unknown;
  permissionContext: unknown;
}

export class GuardianReviewSessionManager {
  private trunk?: Trunk;

  open(
    key: GuardianSessionKey,
    requestPrompt: string,
    tools?: Tool[],
    systemPrompt = AUTO_REVIEW_SYSTEM_PROMPT,
    transcriptMeta?: GuardianTranscriptMeta,
  ): GuardianReviewLease {
    if (
      !this.trunk ||
      !keysMatch(this.trunk.key, key) ||
      this.trunk.systemPrompt !== systemPrompt
    ) {
      this.trunk = {
        key: { ...key },
        systemPrompt,
        // Stable per parent-session id so provider prompt-cache can prefix-hit
        // across consecutive reviews. Codex uses guardian:{parent_thread_id}.
        sessionId: `pi-permissions-guardian-${key.sessionId}`,
        active: false,
        turns: [],
        priorReviewCount: 0,
      };
    }

    const trunk = this.trunk;
    const isFork = trunk.active;
    if (!isFork) trunk.active = true;

    // Decide Full vs Delta. Delta is only safe on the trunk (not forks) and
    // only when the cursor still points inside the current raw log.
    let prompt = requestPrompt;
    let cursorUsed: GuardianTranscriptCursor | undefined;
    let newCursor: GuardianTranscriptCursor | undefined;
    if (transcriptMeta) {
      newCursor = { epoch: transcriptMeta.epoch, seenCount: transcriptMeta.rawEntries.length };
      const last = trunk.lastCursor;
      const canDelta =
        !isFork &&
        last !== undefined &&
        last.epoch === transcriptMeta.epoch &&
        last.seenCount <= transcriptMeta.rawEntries.length;
      if (canDelta && last) {
        cursorUsed = last;
        const delta = boundGuardianTranscriptDelta(
          sliceGuardianTranscriptFrom(transcriptMeta.rawEntries, last.seenCount),
        );
        prompt = renderDeltaReviewPrompt(
          delta,
          transcriptMeta.action,
          transcriptMeta.permissionContext,
        );
      } else {
        prompt = renderAutoReviewPrompt({
          untrustedTranscript: transcriptMeta.rawEntries,
          untrustedAction: transcriptMeta.action,
          permissionContext: transcriptMeta.permissionContext,
        } as Parameters<typeof renderAutoReviewPrompt>[0]);
      }
    }

    const request = createUserMessage(prompt);
    const snapshot = trimTurns(trunk.turns).flat();
    const context = createLeaseContext(snapshot, request, tools, trunk.systemPrompt);
    const sessionId = isFork ? `${trunk.sessionId}-fork-${randomUUID()}` : trunk.sessionId;
    let committed = false;
    let released = false;

    return {
      context,
      sessionId,
      cursorUsed,
      newCursor: newCursor ?? { epoch: 0, seenCount: 0 },
      extend: (messages) => {
        return createContext([...context.messages, ...messages], tools, trunk.systemPrompt);
      },
      commit: (messages) => {
        if (committed || released) return;
        committed = true;
        if (isFork || this.trunk !== trunk) return;
        trunk.turns = trimTurns([...trunk.turns, [request, ...messages]]);
        if (newCursor) {
          trunk.lastCursor = newCursor;
          trunk.priorReviewCount += 1;
        }
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
