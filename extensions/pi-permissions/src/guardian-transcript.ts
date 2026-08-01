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

const MAX_ENTRY_CHARACTERS = 4_000;
const MAX_TRANSCRIPT_CHARACTERS = 12_000;
const TRUNCATION_MARKER = "[...]";

function truncateContent(content: string, limit: number): string {
  if (limit <= 0) return "";
  if (content.length <= limit) return content;
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit);
  return `${content.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function copyEntry(
  entry: GuardianTranscriptEntry,
  contentLimit = MAX_ENTRY_CHARACTERS,
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
  let remaining = MAX_TRANSCRIPT_CHARACTERS - (firstUser?.content.length ?? 0);

  for (let index = normalized.length - 1; index >= 0 && remaining > 0; index -= 1) {
    if (index === firstUserIndex) continue;
    const entry = normalized[index];
    if (!entry) continue;
    const bounded = copyEntry(entry, Math.min(MAX_ENTRY_CHARACTERS, remaining));
    if (bounded.content.length === 0) continue;
    selectedNewest.push(bounded);
    remaining -= bounded.content.length;
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
