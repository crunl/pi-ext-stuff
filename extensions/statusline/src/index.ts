/**
 * statusline — custom footer + model info embedded in the editor's bottom border.
 *
 * Layout:
 *   [ messages ... ]
 *   ─────────────────── ↑284k ↓37.3k ──       <- editor top border (right)
 *    > input…
 *   ── Default•(provider) model•effort ──          <- editor bottom border (left)
 *   ~/path (branch) • name    ↑↓RW$ ctx%           <- footer.ts (setFooter, line 1)
 *   [other extensions' statuses]                   <- footer.ts (optional line 2)
 *
 * Commands:
 *   /statusline  — toggle between this statusline and the built-in layout
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyAutocompleteAbove } from "../../pi-core/src/tui/autocomplete-above.ts";
import { installFooter } from "./footer.ts";
import { ModelLineEditor } from "./model-editor.ts";
import { PermissionsModeState } from "./status-mode.ts";
import { computeUsageTotals } from "./usage.ts";

export default function statusline(pi: ExtensionAPI) {
	let enabled = true;
	// Live model info shared with the editor via closure; updated on events.
	let currentCtx: ExtensionContext | undefined;
	const permissionsMode = new PermissionsModeState();

	const modelInfo = () => {
		const ctx = currentCtx;
		const model = ctx?.model;
		if (!model) return undefined;
		return {
			provider: model.provider,
			modelId: model.id,
			effort: model.reasoning ? (ctx?.thinkingLevel ?? "off") : undefined,
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
		installFooter(ctx, permissionsMode);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new ModelLineEditor(tui, theme, keybindings);
			editor.getModelInfo = modelInfo;
			editor.getStats = stats;
			editor.getPermissionsMode = () => permissionsMode.get();
			return applyAutocompleteAbove(editor);
		});
	};

	const uninstall = (ctx: ExtensionContext) => {
		ctx.ui.setFooter(undefined);
		ctx.ui.setEditorComponent(undefined);
		permissionsMode.update(undefined);
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
