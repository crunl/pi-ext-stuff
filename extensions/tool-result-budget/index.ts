// tool-result-budget — bounds how many characters a *single turn* can add to context
// via tool results, so a big tool output can never "jump" past Pi's compaction trigger.
//
// Why this exists (measured on this machine, 302 sessions):
//   per-request context growth  p50 = 888   p90 = 4.4K   p99 = 15.4K   max = 162.1K tokens
//   Pi's compaction trigger is `tokens > contextWindow - reserveTokens`
//   (dist/core/compaction/compaction.js:160) and is only re-checked between turns, so one
//   oversized batch can land *past* the trigger and into the max_tokens clamp
//   (`available = window - est - 4096`, floor 1 -> "length" + output=1 -> the single
//   overflow-recovery attempt, which then reports "Context overflow recovery failed").
//
// This extension never compacts, never aborts, and never touches Pi's compaction or
// custom entries, so it cannot interact with /goal continuation, pi-subagents, or the
// goal budget accounting. It only shrinks what a tool result contributes.
//
// Behaviour: tool results are kept verbatim until the per-turn budget is spent; anything
// beyond it is written to a spill file and replaced with head + tail + a pointer, so the
// content is still reachable via `read <path> offset/limit` or `grep -n`.
//
// Env overrides (chars): PI_TOOL_TURN_BUDGET (default 60000), PI_TOOL_MIN_KEEP (4000),
// PI_TOOL_SPILL_DIR (default ~/.pi/agent/tool-spill).

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const num = (raw: string | undefined, fallback: number): number => {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const TURN_BUDGET = num(process.env.PI_TOOL_TURN_BUDGET, 60_000); // chars a turn may add via tool results
const MIN_KEEP = num(process.env.PI_TOOL_MIN_KEEP, 4_000); // never shrink a result below this
const HEAD_RATIO = 0.6; // of the kept prefix/suffix split
const SPILL_DIR = process.env.PI_TOOL_SPILL_DIR ?? join(getAgentDir(), "tool-spill");
const LOG_FILE = join(getAgentDir(), "logs", "tool-result-budget.jsonl");

// Standing discipline for the model, injected as its own system-prompt section.
// Generated from the same constants as the clipping logic below, so env
// overrides (PI_TOOL_TURN_BUDGET / PI_TOOL_MIN_KEEP / PI_TOOL_SPILL_DIR)
// can never desync the prompt from the behaviour.
const DISCIPLINE =
	`Tool results are budgeted: at most ${TURN_BUDGET} chars per turn may enter context via tool results; ` +
	`a single result under ${MIN_KEEP} chars is never shrunk. ` +
	`Over-budget output is saved in full to a spill file under ${SPILL_DIR} and replaced in context with head + tail + a pointer banner naming the file. ` +
	`When you need the omitted middle, read the spill file in slices (read <path> offset=... limit=...) or search it (grep -n "pattern" <path>); ` +
	`do not blindly re-run the full command to recover it, and do not draw conclusions from the omitted middle.`;

let spentThisTurn = 0;
let turnSeq = 0;

const log = (row: Record<string, unknown>): void => {
	try {
		mkdirSync(join(getAgentDir(), "logs"), { recursive: true });
		appendFileSync(LOG_FILE, `${JSON.stringify(row)}\n`);
	} catch {
		// logging is best-effort
	}
};

const spill = (toolName: string, text: string): string | null => {
	try {
		mkdirSync(SPILL_DIR, { recursive: true });
		const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${toolName}-${turnSeq}.txt`;
		const path = join(SPILL_DIR, name);
		writeFileSync(path, text);
		return path;
	} catch {
		return null;
	}
};

const clip = (
	text: string,
	keep: number,
	label: string,
	path: string | null,
): string => {
	const head = Math.floor(keep * HEAD_RATIO);
	const tail = keep - head;
	const omittedChars = text.length - keep;
	const omittedLines = text.slice(head, text.length - tail).split("\n").length;
	const lines = text.split("\n").length;
	const pointer = path
		? `Full output spilled to: ${path}\n  read it in slices, e.g. read ${path} offset=200 limit=300\n  or search it, e.g. grep -n "pattern" ${path}`
		: `Full output was dropped (spill failed); re-run the command with a narrower scope if you need the middle.`;
	return (
		`${text.slice(0, head)}\n\n` +
		`[... ${label}: ${omittedChars} chars / ~${omittedLines} lines omitted from the middle ` +
		`of a ${text.length}-char, ${lines}-line result. ${pointer} ...]\n\n` +
		`${text.slice(text.length - tail)}`
	);
};

export default function (pi: ExtensionAPI) {
	// Self-report at load: makes "is this extension actually loaded in this process?"
	// answerable from the log alone. One line per pi process that discovers this file
	// (pid distinguishes the interactive session from subagent child processes).
	log({
		ts: new Date().toISOString(),
		event: "loaded",
		pid: process.pid,
		budget: TURN_BUDGET,
		minKeep: MIN_KEEP,
		spillDir: SPILL_DIR,
	});

	pi.on("turn_start", () => {
		spentThisTurn = 0;
		turnSeq += 1;
	});

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.tool_result_budget = DISCIPLINE;
	});

	pi.on("tool_result", (event) => {
		try {
			const parts = event.content;
			if (!Array.isArray(parts) || parts.length === 0) return undefined;

			// Only text parts can be shrunk; image parts are bounded separately by Pi.
			const textParts = parts.filter((p) => p.type === "text");
			if (textParts.length === 0) return undefined;

			const totalChars = textParts.reduce(
				(sum, p) => sum + (typeof p.text === "string" ? p.text.length : 0),
				0,
			);
			if (totalChars === 0) return undefined;

			// Nothing to do while the turn still has budget for this result.
			const remaining = Math.max(MIN_KEEP, TURN_BUDGET - spentThisTurn);
			if (totalChars <= remaining) {
				spentThisTurn += totalChars;
				return undefined;
			}

			// Over budget: keep the biggest result(s) inside the remaining allowance.
			let allowance = remaining;
			let spilled = false;
			const next: typeof parts = [];
			for (const part of parts) {
				if (part.type !== "text" || typeof part.text !== "string") {
					next.push(part);
					continue;
				}
				const text = part.text;
				if (text.length <= allowance) {
					allowance -= text.length;
					next.push(part);
					continue;
				}
				const keep = Math.max(MIN_KEEP, Math.min(allowance, text.length));
				const path = spill(event.toolName, text);
				next.push({ ...part, text: clip(text, keep, event.toolName, path) });
				allowance = Math.max(0, allowance - keep);
				spilled = true;
			}
			if (!spilled) {
				spentThisTurn += totalChars;
				return undefined;
			}

			spentThisTurn = TURN_BUDGET;
			log({
				ts: new Date().toISOString(),
				event: "truncated",
				pid: process.pid,
				turn: turnSeq,
				tool: event.toolName,
				originalChars: totalChars,
				budget: TURN_BUDGET,
			});
			return { content: next };
		} catch {
			return undefined; // fail-open: always keep the original result
		}
	});
}
