import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { createEditDiffBox } from "./edit-diff.ts";
import {
  type CodexToolRendererSpec,
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  summarizeEditDiff,
} from "./tool-renderer.ts";
import {
  createWritePreview,
  updateWriteHighlightCache,
  type WriteHighlightCache,
} from "./write-preview.ts";

export const codexBashToolSpec: CodexToolRendererSpec = {
  icon: "",
  runningVerb: "Running",
  completedVerb: "Ran",
  argument: (args) => (typeof args.command === "string" ? args.command : ""),
  collapsed: "preview",
  transformOutput: compactBashStatusSpacing,
};

export const codexWriteToolSpec: CodexToolRendererSpec = {
  icon: "",
  runningVerb: "Writing",
  completedVerb: "Wrote",
  argument: (args) => (typeof args.path === "string" ? args.path : ""),
  renderCallPreview(args, theme, context) {
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    const cache = updateWriteHighlightCache(
      context.state.rendererState as WriteHighlightCache | undefined,
      path,
      content,
    );
    context.state.rendererState = cache;
    return createWritePreview(cache, theme);
  },
  renderExpandedResult(_result, args, theme) {
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    return createWritePreview(updateWriteHighlightCache(undefined, path, content), theme);
  },
};

export const codexEditToolSpec: CodexToolRendererSpec = {
  icon: "",
  runningVerb: "Editing",
  completedVerb: "Edited",
  argument: (args) => (typeof args.path === "string" ? args.path : ""),
  collapsed: summarizeEditDiff,
  formatSummary: colorizeEditDiffSummary,
  renderExpandedResult: (result, args, theme, outputPad) => {
    const details = result.details as { diff?: unknown } | undefined;
    return createEditDiffBox(typeof details?.diff === "string" ? details.diff : "", theme, {
      outputPad,
      lang: typeof args.path === "string" ? getLanguageFromPath(args.path) : undefined,
    });
  },
};
