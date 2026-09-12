/**
 * Custom footer — replaces the built-in FooterComponent.
 *
 * Line 1 (powerline chain on the left, stats on the right):
 *   modeleffortfolderbranch     CH66%  ██░░░░░░░░ 1.0k/192k
 * Line 2 (optional): extension statuses from other extensions' setStatus()
 * (pi-lens LSP state is filtered out — the pi-lens widget surfaces it)
 *
 * Gutters follow settings.outputPad via pi-core's shared
 * outputPaddingController, so footer lines up with chat messages.
 *
 * Model/effort live here when SHOW_MODEL_ON_BORDER is false.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
// standalone.ts is pi-core's side-effect-free surface: no register graph
// gets pulled into this jiti instance.
import { outputPaddingController } from "../../pi-core/standalone.ts";
import {
	alignLine,
	formatCwd,
	formatTokens,
	ICONS,
	isHiddenExtensionStatus,
	meterCells,
	stripAnsi,
} from "./format.ts";
import {
	type ModelStatusInfo,
	PermissionsModeState,
	type PowerlineSegment,
	powerlineChain,
	syncPermissionsMode,
} from "./status-mode.ts";
import { computeUsageTotals } from "./usage.ts";

const METER_CELLS = 10;

interface FooterTheme {
	getFgAnsi(color: string): string;
}

export interface FooterOptions {
	getModelInfo?: () => ModelStatusInfo | undefined;
	onTheme?: (theme: FooterTheme) => void;
	onRequestRender?: (requestRender: () => void) => void;
}

export function installFooter(
	ctx: ExtensionContext,
	permissionsMode: PermissionsModeState,
	options: FooterOptions = {},
): void {
	const { getModelInfo, onTheme, onRequestRender } = options;
	if (!ctx.hasUI || ctx.mode !== "tui") return;

	ctx.ui.setFooter((tui, theme, footerData) => {
		try {
			// SAFETY: theme is the live TUI theme object, which exposes getFgAnsi
			// at runtime; the static EditorTheme type just doesn't declare it.
			onTheme?.(theme as unknown as FooterTheme);
		} catch {
			// theme without getFgAnsi: badge falls back to inverse video
		}
		onRequestRender?.(() => queueMicrotask(() => tui.requestRender()));
		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubBranch,
			invalidate() {},
			render(width: number): string[] {
				try {
					// SAFETY: same live-theme invariant as above; re-read every render
					// so hot theme switches refresh badge colors without reinstall.
					onTheme?.(theme as unknown as FooterTheme);
				} catch {
					// theme without getFgAnsi: badge falls back to inverse video
				}
				const t = theme as unknown as FooterTheme;
				const fg = (color: string) => {
					try {
						return t.getFgAnsi(color);
					} catch {
						return undefined;
					}
				};

				// ---- left: powerline model | effort | folder | branch | session ----
				const pwd = formatCwd(
					ctx.sessionManager.getCwd(),
					process.env.HOME || process.env.USERPROFILE,
				);
				const branch = footerData.getGitBranch();
				const sessionName = ctx.sessionManager.getSessionName();
				const model = getModelInfo?.();

				const segments: PowerlineSegment[] = [];
				if (model) {
					segments.push({
						text: `${ICONS.model} ${model.modelId}`,
						ansi: fg("mdLink"),
					});
					if (model.effort) {
						segments.push({
							text: `${ICONS.effort} ${model.effort}`,
							ansi: fg("accent"),
						});
					}
				}
				segments.push({ text: `${ICONS.folder} ${pwd}`, ansi: fg("borderAccent") });
				if (branch) {
					segments.push({ text: `${ICONS.branch} ${branch}`, ansi: fg("success") });
				}
				if (sessionName) {
					segments.push({ text: sessionName, ansi: fg("muted") });
				}

				const leftColored = powerlineChain(segments);
				const leftPlain = stripAnsi(leftColored);

				// ---- right:  cache hit + █░ usage meter + tokens/window ----
				const totals = computeUsageTotals(ctx);
				const rightPlainParts: string[] = [];
				const rightColoredParts: string[] = [];

				if (
					(totals.cacheRead > 0 || totals.cacheWrite > 0) &&
					totals.latestCacheHitRate !== undefined
				) {
					const chText = `CH${totals.latestCacheHitRate.toFixed(1)}%`;
					rightPlainParts.push(`${ICONS.cache} ${chText}`);
					rightColoredParts.push(
						theme.fg("accent", ICONS.cache) + " " + theme.fg("dim", chText),
					);
				}

				const usage = ctx.getContextUsage();
				if (usage) {
					const pctValue = usage.percent ?? 0;
					const meterColor: "error" | "warning" | "success" =
						pctValue >= 75 ? "error" : pctValue >= 50 ? "warning" : "success";

					const filled = meterCells(pctValue, METER_CELLS);
					const meterPlain = "█".repeat(filled) + "░".repeat(METER_CELLS - filled);
					const meterColored =
						(filled > 0 ? theme.fg(meterColor, "█".repeat(filled)) : "") +
						(filled < METER_CELLS
							? theme.fg("dim", "░".repeat(METER_CELLS - filled))
							: "");

					const tokText =
						usage.tokens !== null
							? `${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`
							: `?/${formatTokens(usage.contextWindow)}`;

					rightPlainParts.push(`${ICONS.gauge} ${meterPlain} ${tokText}`);
					rightColoredParts.push(
						theme.fg("accent", ICONS.gauge) +
							" " +
							meterColored +
							" " +
							theme.fg(meterColor, tokText),
					);
				}

				// ---- extension statuses (from other extensions' setStatus) ----
				const statuses = syncPermissionsMode(
					footerData.getExtensionStatuses(),
					permissionsMode,
					() => queueMicrotask(() => tui.requestRender()),
				);
				// pi-lens LSP state is dropped here (the widget surfaces it) —
				// the footer owns presentation, upstream keeps publishing.
				const visible = statuses.filter(([key]) => !isHiddenExtensionStatus(key));

				const statsPlain = rightPlainParts.join("  ");
				const statsColored = rightColoredParts.join("  ");

				// Match chat-message gutters (settings.outputPad). The shared
				// controller is started by pi-core; this import is the same
				// cross-jiti singleton.
				const pad = outputPaddingController.getOutputPad();
				const gutter = " ".repeat(pad);
				const innerWidth = Math.max(0, width - pad * 2);

				const { line, rightFits } = alignLine(
					leftColored,
					visibleWidth(leftPlain),
					statsColored,
					visibleWidth(statsPlain),
					innerWidth,
				);

				const firstLine =
					gutter +
					(rightFits
						? line
						: truncateToWidth(leftColored, innerWidth, theme.fg("dim", "...")));

				const lines = [firstLine];

				if (visible.length > 0) {
					const merged = visible
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\r\n]+/g, " "))
						.join(" ");
					lines.push(
						gutter + truncateToWidth(merged, innerWidth, theme.fg("dim", "...")),
					);
				}

				return lines;
			},
		};
	});
}
