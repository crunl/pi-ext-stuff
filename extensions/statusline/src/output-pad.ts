/**
 * Live `settings.outputPad` for footer gutters.
 *
 * Pi does not expose outputPad (or settings-change events) on the extension
 * footer API — only custom message renderers receive MessageRenderOptions.
 * The footer re-renders often, so we stat the settings files and re-read only
 * when mtime changes: real-time after `/settings` writes, no watch timer.
 *
 * Paths mirror Pi: `PI_CODING_AGENT_DIR` or `~/.pi/agent`, project scope
 * under `<cwd>/.pi` when the project is trusted.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OutputPad = 0 | 1;

const CONFIG_DIR_NAME = ".pi";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function mtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return -1;
	}
}

/** Pi: only literal 0 means 0; anything else (including missing) is 1. */
export function readOutputPadFile(settingsPath: string): OutputPad | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("outputPad" in parsed)) {
			return undefined;
		}
		return (parsed as { outputPad: unknown }).outputPad === 0 ? 0 : 1;
	} catch {
		return undefined;
	}
}

/** Project override wins when the key is present; otherwise fall back to global. */
export function effectiveOutputPad(
	globalPad: OutputPad | undefined,
	projectPad: OutputPad | undefined,
): OutputPad {
	return (projectPad ?? globalPad) === 0 ? 0 : 1;
}

interface PadCache {
	globalMtime: number;
	projectMtime: number;
	pad: OutputPad;
}

let cache: PadCache | undefined;

export function getOutputPad(cwd: string, projectTrusted: boolean): OutputPad {
	const globalPath = join(agentDir(), "settings.json");
	const projectPath = projectTrusted ? join(cwd, CONFIG_DIR_NAME, "settings.json") : undefined;
	const globalMtime = mtimeMs(globalPath);
	const projectMtime = projectPath === undefined ? -1 : mtimeMs(projectPath);

	if (
		cache !== undefined &&
		cache.globalMtime === globalMtime &&
		cache.projectMtime === projectMtime
	) {
		return cache.pad;
	}

	const pad = effectiveOutputPad(
		readOutputPadFile(globalPath),
		projectPath === undefined ? undefined : readOutputPadFile(projectPath),
	);
	cache = { globalMtime, projectMtime, pad };
	return pad;
}

/** Test seam: drop the mtime cache. */
export function resetOutputPadCache(): void {
	cache = undefined;
}
