export const SUPPORTED_VERSION: string;

export const CORE_AGENT_LOOP_PATH: string;

export const coreBackupSuffix: string;

export function corePatchStatus(target?: string): Promise<"installed" | "not-installed">;

export function installCorePatch(target?: string): Promise<"installed" | "already-installed">;
