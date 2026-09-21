/**
 * Token usage aggregation — mirrors the built-in FooterComponent algorithm:
 * iterate ALL session entries, summing usage from assistant messages,
 * toolResult messages, and branch_summary/compaction entries.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Cache hit rate (%) of the latest assistant message, if computable. */
	latestCacheHitRate: number | undefined;
}

export function computeUsageTotals(ctx: ExtensionContext): UsageTotals {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		latestCacheHitRate: undefined,
	};

	const add = (usage: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	}) => {
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
	};

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = (entry.message as { usage: UsageLike }).usage;
			add(usage);
			const latestPrompt =
				(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			totals.latestCacheHitRate =
				latestPrompt > 0
					? ((usage.cacheRead ?? 0) / latestPrompt) * 100
					: undefined;
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			(entry.message as { usage?: UsageLike }).usage
		) {
			add((entry.message as { usage: UsageLike }).usage);
		} else if (
			(entry.type === "branch_summary" || entry.type === "compaction") &&
			(entry as { usage?: UsageLike }).usage
		) {
			add((entry as { usage: UsageLike }).usage);
		}
	}

	return totals;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}
