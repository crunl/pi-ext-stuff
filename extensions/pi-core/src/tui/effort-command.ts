/**
 * /effort — open the host's thinking-level panel (Settings → Thinking level).
 *
 * Uses ctx.ui.custom (editor-slot swap, same path as built-in selectors) so
 * selector-tab-nav and selector-float apply. The panel itself is pi's own
 * ThinkingSelectorComponent, and level availability comes from pi-ai's
 * getSupportedThinkingLevels — search filter, descriptions, and level
 * filtering all stay in the host, so this command cannot drift from
 * Settings the way a mirrored local copy would.
 */

import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ThinkingSelectorComponent } from "@earendil-works/pi-coding-agent";
import { markFloatableSelector } from "./selector-float.ts";
import { isInteractiveTui } from "./ui-guard.ts";

interface EffortChoice {
  level: ModelThinkingLevel;
  /**
   * Save-key was used. Extensions cannot persist the default (the host
   * SettingsManager is not exposed), so this still applies the level to the
   * session and points at /settings — keeping the component's own footer
   * hint honest instead of leaving a dead key.
   */
  asDefault: boolean;
}

/** Register `/effort` slash command. */
export function registerEffortCommand(pi: ExtensionAPI): void {
  pi.registerCommand("effort", {
    description: "Choose thinking level",
    handler: async (_args, ctx) => {
      if (!isInteractiveTui(ctx)) return;

      const model = ctx.model;
      if (!model?.reasoning) {
        ctx.ui.notify("Current model does not support thinking", "warning");
        return;
      }

      const levels = getSupportedThinkingLevels(model);
      const current = pi.getThinkingLevel();

      const chosen = await ctx.ui.custom<EffortChoice | undefined>((_tui, _theme, _kb, done) => {
        const component = new ThinkingSelectorComponent(
          current,
          levels,
          (level) => done({ level, asDefault: false }),
          () => done(undefined),
          (level) => done({ level, asDefault: true }),
        );
        return markFloatableSelector(component);
      });

      if (chosen === undefined) return;

      pi.setThinkingLevel(chosen.level);
      ctx.ui.notify(
        chosen.asDefault
          ? `Thinking level: ${chosen.level} (this session; change the default in /settings)`
          : `Thinking level: ${chosen.level}`,
        "info",
      );
    },
  });
}
