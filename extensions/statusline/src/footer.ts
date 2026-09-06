/**
 * Custom footer — replaces the built-in FooterComponent.
 *
 * Line 1:  📁 ~/path  branch • name           CH66%  ██░░░░░░░░ 1.0k/192k
 *          └─ dim, icons accent ─┘          └─ meter threshold-colored ─┘
 * Line 1 right also inlines the pi-lens LSP state after usage.
 * Line 2 (optional): remaining extension statuses from setStatus()
 *
 * Model info intentionally omitted — it lives in the editor's bottom border.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	alignLine,
	formatCwd,
	formatTokens,
	ICONS,
	meterCells,
	partitionLspStatus,
} from "./format.ts";
import { PermissionsModeState, syncPermissionsMode } from "./status-mode.ts";
import { computeUsageTotals } from "./usage.ts";

const METER_CELLS = 10;

export function installFooter(
	ctx: ExtensionContext,
	permissionsMode: PermissionsModeState,
	onTheme?: (theme: { getFgAnsi(color: string): string }) => void,
	onRequestRender?: (requestRender: () => void) => void,
): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;

	ctx.ui.setFooter((tui, theme, footerData) => {
		try {
			// SAFETY: theme is the live TUI theme object, which exposes getFgAnsi
			// at runtime; the static EditorTheme type just doesn't declare it.
			// Failure falls through to the inverse-video badge fallback below.
			onTheme?.(theme as unknown as { getFgAnsi(color: string): string });
		} catch {
			// theme without getFgAnsi: badge falls back to inverse video
		}
		onRequestRender?.(() => queueMicrotask(() => tui.requestRender()));
		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubBranch,
			invalidate() {},
			render(width: number): string[] {
				// Live-read the theme on every render: the theme object is a live
				// proxy, so hot theme switches (file watch or /theme) refresh the
				// badge colors without a reinstall.
				try {
					// SAFETY: same live-theme invariant as above; re-read every render
					// so hot theme switches refresh badge colors without reinstall.
					onTheme?.(theme as unknown as { getFgAnsi(color: string): string });
				} catch {
					// theme without getFgAnsi: badge falls back to inverse video
				}
				// ---- left: 📁 pwd  branch • session-name ----
				const pwd = formatCwd(
					ctx.sessionManager.getCwd(),
					process.env.HOME || process.env.USERPROFILE,
				);
				const branch = footerData.getGitBranch();
				const sessionName = ctx.sessionManager.getSessionName();

				let leftPlain = `${ICONS.folder} ${pwd}`;
				let leftColored =
					theme.fg("accent", ICONS.folder) + theme.fg("dim", ` ${pwd}`);
				if (branch) {
					leftPlain += ` ${ICONS.branch} ${branch}`;
					leftColored +=
						" " + theme.fg("accent", ICONS.branch) + theme.fg("dim", ` ${branch}`);
				}
				if (sessionName) {
					leftPlain += ` • ${sessionName}`;
					leftColored += theme.fg("dim", ` • ${sessionName}`);
				}

				// ---- right:  cache hit + █░ usage meter + tokens/window ----
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
				// pi-lens LSP state moves up to the first line (right side,
				// after usage); remaining statuses share the second line.
				// The LSP text carries its own ANSI colors; visibleWidth
				// below strips them for layout, so it can join the parts.
				const { lsp, rest: visible } = partitionLspStatus(statuses);
				if (lsp) {
					rightPlainParts.push(lsp);
					rightColoredParts.push(lsp);
				}

				const statsPlain = rightPlainParts.join("  ");
				const statsColored = rightColoredParts.join("  ");

				const { line, rightFits } = alignLine(
					leftColored,
					visibleWidth(leftPlain),
					statsColored,
					visibleWidth(statsPlain),
					width,
				);

				const firstLine = rightFits
					? line
					: truncateToWidth(leftColored, width, theme.fg("dim", "..."));

				const lines = [firstLine];

				if (visible.length > 0) {
					const merged = visible
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\r\n]+/g, " "))
						.join(" ");
					lines.push(truncateToWidth(merged, width, theme.fg("dim", "...")));
				}

				return lines;
			},
		};
	});
}
