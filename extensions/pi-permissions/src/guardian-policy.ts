export const GUARDIAN_REVIEW_TIMEOUT_MS = 90_000;
export const GUARDIAN_REVIEW_MAX_ATTEMPTS = 3;
export const MAX_CONSECUTIVE_GUARDIAN_DENIALS = 3;
export const MAX_RECENT_GUARDIAN_DENIALS = 10;
export const GUARDIAN_DENIAL_WINDOW_SIZE = 50;

export function guardianRetryDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 1_000);
}
