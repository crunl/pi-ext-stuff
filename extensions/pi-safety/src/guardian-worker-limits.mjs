// Shared Guardian worker protocol limits. Imported by both the TypeScript
// client and the plain .mjs worker entry point (which must not import TypeScript).
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
// Bounds an envelope id in both directions. Client and worker must agree, or a
// request the client built is rejected before the worker can answer it.
export const MAX_ID_LENGTH = 128;
