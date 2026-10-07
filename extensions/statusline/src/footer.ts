/**
 * Custom footer — replaces the built-in FooterComponent.
 *
 * Line 1 (left context + right telemetry, both width-degrading):
 *   modeleffortfolderbranch     CH66%  ██░░░░░░░░ 1.0k/192k
 * Line 2 (optional): extension statuses from other extensions' setStatus()
 * (pi-lens LSP state is filtered out — the pi-lens widget surfaces it)
 *
 * All width adaptation and line composition live in `degrade.ts` (pure, with
 * `measure`/`truncate`/`fg` injected). This file's only job is to gather live
 * data from ctx and hand it to `renderFooterLines`, which owns the pi-tui
 * width invariant (a rendered line wider than the terminal throws and stops
 * the TUI — see tui-main-screen.js).
 *
 * Gutters follow settings.outputPad (read live from settings.json), so the
 * footer lines up with chat messages without any sibling dependency.
 * Model/effort live here (the editor border is owned by the core extension's
 * editor chrome).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type LeftSeg, renderFooterLines } from "./degrade.ts";
import { formatCwd, ICONS } from "./format.ts";
import { getOutputPad } from "./output-pad.ts";
import { effortColor, isLightThemeFrom, paletteForLight } from "./palette.ts";
import { createUsageCache } from "./usage.ts";

interface FooterTheme {
	fg(color: string, text: string): string;
	getFgAnsi(color: string): string;
	getBgAnsi?(color: string): string;
}

export interface FooterOptions {
	getModelInfo?: () => { modelId: string; effort: string | undefined } | undefined;
}

export function installFooter(
	ctx: ExtensionContext,
	options: FooterOptions = {},
): void {
	const { getModelInfo } = options;
	if (!ctx.hasUI || ctx.mode !== "tui") return;

	// Per-install usage cache (fresh on every session_start install): render
	// fires per streaming chunk but usage only changes per session-state
	// change, so gather-once-per-key instead of traversing per frame.
	const usageCache = createUsageCache();

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
		const th = theme as unknown as FooterTheme;

		return {
			dispose: unsubBranch,
			invalidate() {},
			render(width: number): string[] {
				// ---- gather live data (once per frame) ----
				const home = process.env.HOME || process.env.USERPROFILE;
				const branch = footerData.getGitBranch();
				const model = getModelInfo?.();

				// Catppuccin latte/frappe accents; light/dark from live bg.
				const pal = paletteForLight(isLightThemeFrom(th));

				const leftSegments: LeftSeg[] = [];
				if (model) {
					leftSegments.push({
						key: "model",
						text: model.modelId,
						hex: pal.fixed.model,
						icon: ICONS.model,
					});
					if (model.effort) {
						leftSegments.push({
							key: "effort",
							text: model.effort,
							hex: effortColor(model.effort, pal),
							icon: ICONS.effort,
						});
					}
				}
				leftSegments.push({
					key: "folder",
					text: formatCwd(ctx.sessionManager.getCwd(), home),
					hex: pal.fixed.folder,
					icon: ICONS.folder,
				});
				if (branch) {
					leftSegments.push({
						key: "branch",
						text: branch,
						hex: pal.fixed.git,
						icon: ICONS.branch,
					});
				}

				// Cache hit rate + context usage share one snapshot: both derive
				// from the same session state, refreshed together only when the
				// session/leaf/model key changes. Hot frames do zero entry
				// traversal (neither ours nor the host's projection).
				// NOTE: the two sources are NOT interchangeable — `totals`
				// sums historical usage (CH% block), `usage` is the host's
				// live context-window estimate (meter). They are only
				// co-cached, never merged.
				const snapshot = usageCache.get(ctx, model?.modelId);
				const totals = snapshot.totals;
				const hasCache = totals.cacheRead > 0 || totals.cacheWrite > 0;
				const cacheRate =
					hasCache && totals.latestCacheHitRate !== undefined
						? totals.latestCacheHitRate
						: undefined;

				const usage = snapshot.usage;
				const rightUsage = usage
					? {
							percent: usage.percent ?? null,
							tokens: usage.tokens ?? null,
							window: usage.contextWindow,
						}
					: undefined;

				// outputPad read live with an mtime cache; trust/cwd read per frame
				// so a mid-session /trust is not sticky-stale.
				const pad = getOutputPad(ctx.cwd, ctx.isProjectTrusted());

				return renderFooterLines(
					{
						width,
						pad,
						left: { segments: leftSegments },
						right: { cacheRate, usage: rightUsage },
						statuses: footerData.getExtensionStatuses(),
					},
					{
						measure: visibleWidth,
						truncate: (text, w, suffix) => truncateToWidth(text, w, suffix),
						fg: (color, text) => th.fg(color, text),
					},
				);
			},
		};
	});
}
