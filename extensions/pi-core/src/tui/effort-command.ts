/**
 * /effort — open a thinking-level panel matching Settings → Thinking level.
 *
 * Uses ctx.ui.custom (editor-slot swap, same path as built-in selectors) so
 * selector-tab-nav and selector-float apply. UI mirrors settings' SelectSubmenu:
 * title, subtitle, SelectList with label+description, preselect current.
 * Esc dismisses back to the editor (top-level command, not a settings submenu).
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, type SelectListTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { markFloatableSelector } from "./selector-float.ts";

/** Same copy as settings-selector / ThinkingSelectorComponent (0.82.1). */
export const THINKING_DESCRIPTIONS: Record<string, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};

/** Host order from @earendil-works/pi-ai getSupportedThinkingLevels. */
export const EXTENDED_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type EffortLevel = (typeof EXTENDED_THINKING_LEVELS)[number];

/** Minimal model shape needed to mirror host level filtering. */
export interface EffortModelInfo {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/**
 * Mirror of pi-ai getSupportedThinkingLevels (kept local for unit tests
 * without jiti virtualModules).
 */
export function availableThinkingLevels(model: EffortModelInfo | undefined | null): EffortLevel[] {
  if (!model?.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

const SELECT_LAYOUT = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
};

/**
 * Settings-parity thinking picker. Marked floatable so selector-float lifts
 * it into EditorFloatPanel. Forwards input to the inner SelectList
 * (Container alone does not).
 */
export class EffortSelectorComponent extends Container {
  private readonly selectList: SelectList;

  constructor(
    theme: Theme,
    currentLevel: string,
    levels: readonly string[],
    onSelect: (level: string) => void,
    onCancel: () => void,
    /** Test seam: avoid pi theme singleton when provided. */
    selectListTheme?: SelectListTheme,
  ) {
    super();
    // Cross-jiti brand — constructor.name alone is unreliable under loaders.
    markFloatableSelector(this);

    this.addChild(new Text(theme.bold(theme.fg("accent", "Thinking Level")), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(theme.fg("muted", "Select reasoning depth for thinking-capable models"), 0, 0),
    );
    this.addChild(new Spacer(1));

    const items = levels.map((level) => ({
      value: level,
      label: level,
      description: THINKING_DESCRIPTIONS[level] ?? "",
    }));

    this.selectList = new SelectList(
      items,
      Math.min(items.length, 10),
      selectListTheme ?? getSelectListTheme(),
      SELECT_LAYOUT,
    );

    const currentIndex = items.findIndex((item) => item.value === currentLevel);
    if (currentIndex !== -1) {
      this.selectList.setSelectedIndex(currentIndex);
    }

    this.selectList.onSelect = (item) => {
      onSelect(item.value);
    };
    this.selectList.onCancel = () => {
      onCancel();
    };

    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to cancel"), 0, 0));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}

/** Register `/effort` slash command. */
export function registerEffortCommand(pi: ExtensionAPI): void {
  pi.registerCommand("effort", {
    description: "Choose thinking level",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;

      const model = ctx.model as EffortModelInfo | undefined;
      if (!model?.reasoning) {
        ctx.ui.notify("Current model does not support thinking", "warning");
        return;
      }

      const levels = availableThinkingLevels(model);
      const current = pi.getThinkingLevel();

      const chosen = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
        return new EffortSelectorComponent(
          theme,
          current,
          levels,
          (level) => done(level),
          () => done(undefined),
        );
      });

      if (chosen === undefined) return;

      pi.setThinkingLevel(chosen as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
      ctx.ui.notify(`Thinking level: ${chosen}`, "info");
    },
  });
}
