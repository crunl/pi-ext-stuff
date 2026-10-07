import assert from "node:assert/strict";
import test from "node:test";
import {
	computeUsageTotals,
	createUsageCache,
	type UsageTotals,
} from "../src/usage.ts";

// ---------------------------------------------------------------- test seam
//
// usage.ts only imports pi types (`import type` — erased under
// --experimental-strip-types), so a structural fake ctx is enough. The fake
// sessionManager counts getEntries()/getContextUsage() calls to prove the
// hot path performs zero traversal.

type Ctx = Parameters<typeof computeUsageTotals>[0];

interface FakeEntry {
	type: string;
	id: string;
	message?: { role: string; usage?: Record<string, number> };
	usage?: Record<string, number>;
}

function assistant(id: string, usage?: Record<string, number>): FakeEntry {
	return {
		type: "message",
		id,
		message: usage ? { role: "assistant", usage } : { role: "assistant" },
	};
}

function toolResult(id: string, usage?: Record<string, number>): FakeEntry {
	return {
		type: "message",
		id,
		message: { role: "toolResult", ...(usage ? { usage } : {}) },
	};
}

function compaction(id: string, usage: Record<string, number>): FakeEntry {
	return { type: "compaction", id, usage };
}

interface FakeCtx {
	entryCalls: number;
	usageCalls: number;
	sessionId: string;
	leafId: string | null;
	entries: FakeEntry[];
	modelKey: string | undefined;
	hostUsage: { percent: number | null; tokens: number | null; window: number } | undefined;
	throwOnKey: boolean;
	ctx: Ctx;
}

function makeFake(): FakeCtx {
	const fake = {} as FakeCtx;
	fake.entryCalls = 0;
	fake.usageCalls = 0;
	fake.sessionId = "sess-1";
	fake.leafId = null;
	fake.entries = [];
	fake.modelKey = "model-a";
	fake.hostUsage = { percent: 10, tokens: 1000, window: 10000 };
	fake.throwOnKey = false;
	fake.ctx = {
		sessionManager: {
			getSessionId: () => {
				if (fake.throwOnKey) throw new Error("no key");
				return fake.sessionId;
			},
			getLeafId: () => {
				if (fake.throwOnKey) throw new Error("no key");
				return fake.leafId;
			},
			getEntries: () => {
				fake.entryCalls += 1;
				return fake.entries.filter((e) => e.type !== "session");
			},
		},
		getContextUsage: () => {
			fake.usageCalls += 1;
			return fake.hostUsage;
		},
	} as unknown as Ctx;
	return fake;
}

/** Append like the host does: entries are append-only, leaf advances. */
function append(fake: FakeCtx, entry: FakeEntry): void {
	fake.entries.push(entry);
	fake.leafId = entry.id;
}

function totalsOf(fake: FakeCtx): UsageTotals {
	return computeUsageTotals(fake.ctx);
}

// --------------------------------------------------------------------- tests

test("repeat frames with unchanged state perform zero traversal", () => {
	const fake = makeFake();
	append(fake, assistant("a1", { input: 100, output: 50, cacheRead: 300, cacheWrite: 100 }));
	const cache = createUsageCache();
	const first = cache.get(fake.ctx, fake.modelKey);
	const second = cache.get(fake.ctx, fake.modelKey);
	assert.equal(fake.entryCalls, 1, "getEntries must run once, then serve from cache");
	assert.equal(fake.usageCalls, 1, "host getContextUsage must run once, then serve from cache");
	assert.equal(second, first, "cache hit must return the identical snapshot");
	assert.deepEqual(first.totals, totalsOf(fake));
});

test("append invalidates once and matches a full recompute", () => {
	const fake = makeFake();
	append(fake, assistant("a1", { input: 100, output: 50, cacheRead: 300, cacheWrite: 100 }));
	const cache = createUsageCache();
	cache.get(fake.ctx, fake.modelKey);
	append(fake, toolResult("t1", { input: 10, output: 5 }));
	append(fake, compaction("c1", { input: 1000, output: 200 }));
	const snap = cache.get(fake.ctx, fake.modelKey);
	assert.equal(fake.entryCalls, 2, "one refresh for the batch of appends");
	assert.equal(fake.usageCalls, 2);
	assert.deepEqual(snap.totals, totalsOf(fake));
	assert.equal(snap.totals.input, 100 + 10 + 1000);
	assert.equal(snap.totals.output, 50 + 5 + 200);
});

test("RED LINE: same length but different leaf recomputes (not length-only)", () => {
	const fake = makeFake();
	append(fake, assistant("a1", { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 }));
	const cache = createUsageCache();
	const before = cache.get(fake.ctx, fake.modelKey);
	// Branch switch: host branch() retargets the leaf; length is unchanged
	// but the visible entries (and totals) differ.
	fake.entries = [assistant("b1", { input: 7, output: 7, cacheRead: 1, cacheWrite: 1 })];
	fake.leafId = "b1";
	const after = cache.get(fake.ctx, fake.modelKey);
	assert.notEqual(after, before, "leaf change must invalidate even at equal length");
	assert.equal(fake.entryCalls, 2);
	assert.deepEqual(after.totals, totalsOf(fake));
	assert.equal(after.totals.input, 7);
});

test("session switch and model switch invalidate", () => {
	const fake = makeFake();
	append(fake, assistant("a1", { input: 100, output: 10, cacheRead: 50, cacheWrite: 50 }));
	const cache = createUsageCache();
	cache.get(fake.ctx, fake.modelKey);
	const calls = fake.entryCalls;

	fake.sessionId = "sess-2"; // resume/fork: new session header id
	cache.get(fake.ctx, fake.modelKey);
	assert.equal(fake.entryCalls, calls + 1, "session change must invalidate");

	fake.modelKey = "model-b"; // model change: host window may differ
	const withModel = cache.get(fake.ctx, fake.modelKey);
	assert.equal(fake.entryCalls, calls + 2, "model change must invalidate");
	assert.equal(withModel.usage, fake.hostUsage);
});

test("zero-usage assistant (interrupt/error) keeps the last hit rate", () => {
	const fake = makeFake();
	append(fake, assistant("a1", { input: 100, output: 10, cacheRead: 300, cacheWrite: 100 }));
	append(fake, assistant("a2", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })); // interrupted: zero usage
	const cache = createUsageCache();
	const snap = cache.get(fake.ctx, fake.modelKey);
	assert.deepEqual(snap.totals, totalsOf(fake));
	assert.equal(snap.totals.latestCacheHitRate, (300 / (100 + 300 + 100)) * 100);
});

test("unreadable key fails open to a full refresh", () => {
	const fake = makeFake();
	append(fake, assistant("a1", { input: 5, output: 5 }));
	fake.throwOnKey = true;
	const cache = createUsageCache();
	const snap = cache.get(fake.ctx, fake.modelKey);
	assert.deepEqual(snap.totals, totalsOf(fake));
	assert.ok(fake.entryCalls >= 1, "must still compute without a key");
});
