/**
 * statusline — custom footer.
 *
 * Layout:
 *   [ messages ... ]
 *   ╭──Auto────────────────────────────────╮  <- editor chrome (core-owned)
 *   │ input…                                │
 *   ╰──────────────────────────────────────╯
 *   modeleffortfolderbranch   CH% █░ tok  <- footer powerline + stats
 *   [other extensions' statuses]              <- footer.ts (optional line 2)
 *
 * Commands:
 *   /statusline  — toggle between this statusline and the built-in layout
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installFooter } from "./footer.ts";
import { resolveModelInfo } from "./model-info.ts";

export default function statusline(pi: ExtensionAPI) {
	let enabled = true;
	// Live model info shared with the footer via closure; updated on events.
	let currentCtx: ExtensionContext | undefined;

	const modelInfo = () => {
		const ctx = currentCtx;
		const model = ctx?.model;
		if (!model) return undefined;
		return resolveModelInfo({
			modelId: model.name?.trim() || model.id,
			reasoning: Boolean(model.reasoning),
			thinkingLevel: ctx?.thinkingLevel,
		});
	};

	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		currentCtx = ctx;

		installFooter(ctx, { getModelInfo: modelInfo });
	};

	const uninstall = (ctx: ExtensionContext) => {
		ctx.ui.setFooter(undefined);
	};

	// Install on every session (also covers /resume, forks, session switches)
	pi.on("session_start", (_event, ctx) => {
		if (enabled) install(ctx);
	});

	// Model or thinking level changed — footer reads modelInfo() live.
	pi.on("model_select", (_event, ctx) => {
		currentCtx = ctx;
	});

	pi.registerCommand("statusline", {
		description: "Toggle custom statusline footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				install(ctx);
				ctx.ui.notify("statusline: custom footer enabled", "info");
			} else {
				uninstall(ctx);
				ctx.ui.notify("statusline: built-in footer restored", "info");
			}
		},
	});
}
