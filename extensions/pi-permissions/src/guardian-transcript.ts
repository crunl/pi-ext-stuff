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
): GuardianTranscriptEntry[] {
  return boundGuardianTranscript([
    ...entries.map((existing) => copyEntry(existing)),
    copyEntry(entry),
  ]);
}
