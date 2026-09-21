export type GuardianTranscriptRole = "user" | "assistant" | "tool";

export type GuardianTranscriptEntry =
  | {
      role: "user" | "assistant";
      content: string;
    }
  | {
      role: "tool";
      toolName: string;
      content: string;
      isError: boolean;
    };

const MAX_MESSAGE_ENTRY_CHARACTERS = 2_000;
const MAX_TOOL_ENTRY_CHARACTERS = 1_000;
const MAX_MESSAGE_CHARACTERS = 10_000;
const MAX_TOOL_CHARACTERS = 10_000;
const MAX_RECENT_ENTRIES = 40;
const TRUNCATION_MARKER = "[...]";

// Raw-log hard cap. When exceeded the head is dropped and the caller must
// bump its epoch so the next review falls back to Full.
export const MAX_RAW_TRANSCRIPT_ENTRIES = 500;
export const MAX_RAW_TRANSCRIPT_CHARACTERS = 200_000;

function truncateContent(content: string, limit: number): string {
  if (limit <= 0) return "";
  if (content.length <= limit) return content;
  if (limit < TRUNCATION_MARKER.length) return "";
  return `${content.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function copyEntry(
  entry: GuardianTranscriptEntry,
  contentLimit = entry.role === "tool" ? MAX_TOOL_ENTRY_CHARACTERS : MAX_MESSAGE_ENTRY_CHARACTERS,
): GuardianTranscriptEntry {
  const content = truncateContent(entry.content, contentLimit);
  if (entry.role === "tool") {
    return {
      role: "tool",
      toolName: entry.toolName,
      content,
      isError: entry.isError,
    };
  }
  return {
    role: entry.role,
    content,
  };
}

export function boundGuardianTranscript(
  entries: readonly GuardianTranscriptEntry[],
): GuardianTranscriptEntry[] {
  const normalized = entries.map((entry) => copyEntry(entry));
  const firstUserIndex = normalized.findIndex((entry) => entry.role === "user");
  const firstUser = firstUserIndex >= 0 ? normalized[firstUserIndex] : undefined;
  const selectedNewest: GuardianTranscriptEntry[] = [];
  let remainingMessages = MAX_MESSAGE_CHARACTERS - (firstUser?.content.length ?? 0);
  let remainingTools = MAX_TOOL_CHARACTERS;

  for (
    let index = normalized.length - 1;
    index >= 0 && selectedNewest.length < MAX_RECENT_ENTRIES;
    index -= 1
  ) {
    if (index === firstUserIndex) continue;
    const entry = normalized[index];
    if (!entry) continue;
    const isTool = entry.role === "tool";
    const remaining = isTool ? remainingTools : remainingMessages;
    if (remaining <= 0) continue;
    const entryLimit = isTool ? MAX_TOOL_ENTRY_CHARACTERS : MAX_MESSAGE_ENTRY_CHARACTERS;
    const bounded = copyEntry(entry, Math.min(entryLimit, remaining));
    if (bounded.content.length === 0) continue;
    selectedNewest.push(bounded);
    if (isTool) remainingTools -= bounded.content.length;
    else remainingMessages -= bounded.content.length;
  }

  const newestInOriginalOrder = selectedNewest.reverse();
  return firstUser ? [copyEntry(firstUser), ...newestInOriginalOrder] : newestInOriginalOrder;
}

export function appendGuardianTranscript(
  entries: readonly GuardianTranscriptEntry[],
  entry: GuardianTranscriptEntry,
): { entries: GuardianTranscriptEntry[]; truncated: boolean } {
  // Append-only raw log. Windowed bounding happens only when building a
  // Full-mode prompt so the cursor stays meaningful for Delta reviews.
  const next = [...entries, copyEntry(entry)];
  if (next.length <= MAX_RAW_TRANSCRIPT_ENTRIES) {
    let characters = 0;
    for (const existing of next) characters += existing.content.length;
    if (characters <= MAX_RAW_TRANSCRIPT_CHARACTERS) return { entries: next, truncated: false };
  }
  // Over hard cap: drop from the head until under both limits. Callers that
  // track a cursor must treat this as epoch-invalidating.
  let start = 0;
  let characters = 0;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const entryCharacters = next[index]?.content.length ?? 0;
    if (
      next.length - index > MAX_RAW_TRANSCRIPT_ENTRIES ||
      characters + entryCharacters > MAX_RAW_TRANSCRIPT_CHARACTERS
    ) {
      break;
    }
    characters += entryCharacters;
    start = index;
  }
  return { entries: next.slice(start), truncated: true };
}

/** Entries not yet sent to the reviewer, for Delta-mode prompts. */
export function sliceGuardianTranscriptFrom(
  entries: readonly GuardianTranscriptEntry[],
  seenCount: number,
): GuardianTranscriptEntry[] {
  if (seenCount <= 0) return entries.map((entry) => copyEntry(entry));
  if (seenCount >= entries.length) return [];
  return entries.slice(seenCount).map((entry) => copyEntry(entry));
}

/** Bound a Delta slice so a large increment cannot blow the prompt budget. */
export function boundGuardianTranscriptDelta(
  entries: readonly GuardianTranscriptEntry[],
): GuardianTranscriptEntry[] {
  return boundGuardianTranscript(entries);
}
