/**
 * statusline — custom footer + boxed editor chrome with embedded status.
 *
 * Layout:
 *   [ messages ... ]
 *   ╭──Auto────────────── ↑284k ↓37.3k ─╮   <- editor top (pill + stats)
 *   │ input…                              │
 *   ╰─────────────────────────────────────╯   <- editor bottom (plain when
 *                                                SHOW_MODEL_ON_BORDER=false)
 *   modeleffortfolderbranch   CH% █░ tok  <- footer powerline + stats
 *   [other extensions' statuses]              <- footer.ts (optional line 2)
 *
 * Commands:
 *   /statusline  — toggle between this statusline and the built-in layout
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// standalone.ts is pi-core's side-effect-free surface: no register graph
// gets pulled into this jiti instance.
import { applyAutocompleteAbove } from "../../pi-core/standalone.ts";
import { installFooter } from "./footer.ts";
import { ModelLineEditor } from "./model-editor.ts";
import { isPermissionsModeEvent, PermissionsModeState } from "./status-mode.ts";
import { computeUsageTotals } from "./usage.ts";

export default function statusline(pi: ExtensionAPI) {
	let enabled = true;
	// Live model info shared with the editor via closure; updated on events.
	let currentCtx: ExtensionContext | undefined;
	const permissionsMode = new PermissionsModeState();

	// Preferred mode source: structured events from pi-permissions. The
	// setStatus string (see footer.ts / syncPermissionsMode) stays as a
	// fallback for pi-permissions builds that predate this event.
	// requestRender is captured from the footer factory once installed.
	let requestRender: (() => void) | undefined;
	pi.events.on("pi-permissions:mode", (data) => {
		if (!isPermissionsModeEvent(data)) return;
		if (permissionsMode.applyEvent(data)) requestRender?.();
	});

	const modelInfo = () => {
		const ctx = currentCtx;
		const model = ctx?.model;
		if (!model) return undefined;
		const level = ctx?.thinkingLevel ?? "off";
		return {
			// Prefer the display name; fall back to the raw id when absent.
			modelId: model.name?.trim() || model.id,
			// "off" is the default — hide the segment rather than label it.
			effort: model.reasoning && level !== "off" ? level : undefined,
		};
	};

	const stats = () => {
		if (!currentCtx) return undefined;
		const totals = computeUsageTotals(currentCtx);
		return { input: totals.input, output: totals.output };
	};

	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		currentCtx = ctx;
		// Captured from the footer factory's theme (full Theme, not EditorTheme).
		const badgeFgAnsi: Partial<Record<"warning" | "error", string>> = {};
		const pillFgAnsi: Partial<Record<"mdLink" | "accent", string>> = {};
		installFooter(ctx, permissionsMode, {
			getModelInfo: modelInfo,
			onTheme: (theme) => {
				badgeFgAnsi.warning = theme.getFgAnsi("warning");
				badgeFgAnsi.error = theme.getFgAnsi("error");
				pillFgAnsi.mdLink = theme.getFgAnsi("mdLink");
				pillFgAnsi.accent = theme.getFgAnsi("accent");
			},
			onRequestRender: (fn) => {
				requestRender = fn;
			},
		});
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new ModelLineEditor(tui, theme, keybindings);
			editor.getModelInfo = modelInfo;
			editor.getStats = stats;
			editor.getPermissionsMode = () => {
				const severity = permissionsMode.severity();
				const label = permissionsMode.get();
				if (severity === "none" || label === undefined) return undefined;
				return { label, severity };
			};
			editor.getBadgeFgAnsi = (color) => badgeFgAnsi[color];
			editor.getPillFgAnsi = (color) => pillFgAnsi[color];
			return applyAutocompleteAbove(editor, tui as Parameters<typeof applyAutocompleteAbove>[1]);
		});
	};

	const uninstall = (ctx: ExtensionContext) => {
		ctx.ui.setFooter(undefined);
		ctx.ui.setEditorComponent(undefined);
		permissionsMode.reset();
	};

	// Install on every session (also covers /resume, forks, session switches)
	pi.on("session_start", (_event, ctx) => {
		if (enabled) install(ctx);
	});

	// Model or thinking level changed — editor border reads modelInfo() live,
	// just keep ctx fresh (ctx.model/thinkingLevel are per-context snapshots).
	pi.on("model_select", (_event, ctx) => {
		currentCtx = ctx;
	});

	pi.registerCommand("statusline", {
		description: "Toggle custom statusline (footer + editor border model info)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				install(ctx);
				ctx.ui.notify("statusline: custom layout enabled", "info");
			} else {
				uninstall(ctx);
				ctx.ui.notify("statusline: built-in layout restored", "info");
			}
		},
	});
}
