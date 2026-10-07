/**
 * Token usage aggregation — mirrors the built-in FooterComponent algorithm:
 * iterate ALL session entries, summing usage from assistant messages,
 * toolResult messages, and branch_summary/compaction entries.
 */

import type {
	ContextUsage,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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
			// Only update on a computable rate. An assistant message with no
			// usage (interrupt, error) must not blank the last known hit rate —
			// otherwise CH% flickers away after every interrupt.
			if (latestPrompt > 0) {
				totals.latestCacheHitRate = ((usage.cacheRead ?? 0) / latestPrompt) * 100;
			}
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

/**
 * Cached usage snapshot: token totals (for the CH% block) plus the host's
 * context-window estimate (for the meter). Both derive from the same session
 * state, so they share one dirty key and are refreshed together.
 */
export interface UsageSnapshot {
	totals: UsageTotals;
	usage: ContextUsage | undefined;
}

export interface UsageCache {
	/**
	 * O(1) when session state is unchanged (no `getEntries()` copy, no
	 * traversal, no host projection); one full refresh otherwise.
	 * `modelKey` is the already-resolved model id (or undefined): the host's
	 * context window — and therefore `usage` — depends on the active model.
	 */
	get(ctx: ExtensionContext, modelKey: string | undefined): UsageSnapshot;
}

/**
 * Per-frame usage cache. The footer renders every streaming chunk, but usage
 * only changes when session state changes — so `render` must not traverse
 * entries per frame (50k entries ≈ 7ms/frame: `getEntries()` copies via
 * `filter`, then we walk the copy, then the host builds a projection for
 * `getContextUsage()` — three O(n) passes per chunk).
 *
 * Dirty key: `sessionId + leafId + modelKey`, all O(1) getters. Correctness
 * rests on the host invariant (session-manager.js: the session is
 * append-only — every `append*` advances `leafId` via `_appendEntry`,
 * `branch()` retargets `leafId`, resume/fork/new-file change `sessionId`
 * from the session header). In particular the key is NOT length-only: a
 * branch switch or compaction can keep the length while changing the leaf,
 * and both change `leafId`. If the key cannot be read, fail open to a full
 * refresh (today's behaviour).
 *
 * One instance per footer install (`installFooter` creates it): a new
 * session installs a new footer, so cross-session leakage is impossible
 * even without the `sessionId` key component.
 */
export function createUsageCache(): UsageCache {
	let key: string | undefined;
	let snapshot: UsageSnapshot | undefined;

	return {
		get(ctx: ExtensionContext, modelKey: string | undefined): UsageSnapshot {
			let fresh: string | undefined;
			try {
				fresh = `${ctx.sessionManager.getSessionId()}\n${ctx.sessionManager.getLeafId()}\n${modelKey ?? ""}`;
			} catch {
				fresh = undefined;
			}
			if (fresh !== undefined && fresh === key && snapshot !== undefined) {
				return snapshot;
			}
			const next: UsageSnapshot = {
				totals: computeUsageTotals(ctx),
				usage: ctx.getContextUsage(),
			};
			key = fresh;
			snapshot = next;
			return next;
		},
	};
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}
