export const CORE_AGENT_LOOP_PATH: string;

export function corePatchStatus(target?: string): Promise<"installed" | "not-installed">;

export function installCorePatch(target?: string): Promise<"installed" | "already-installed">;
