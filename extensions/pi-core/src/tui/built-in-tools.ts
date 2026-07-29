import {
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  countNonEmptyLines,
} from "./tool-output.ts";
import {
  createCodexToolRendering,
} from "./tool-renderer.ts";

function textOutput(result: AgentToolResult<unknown>): string {
  return result.content
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("\n");
}

function countSummary(noun: string, plural = `${noun}s`) {
  return (result: AgentToolResult<unknown>): string | undefined => {
    const count = countNonEmptyLines(textOutput(result));
    return count > 0 ? `${count} ${count === 1 ? noun : plural}` : undefined;
  };
}

function readArgument(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return path;
  const start = offset ?? 1;
  const end = limit === undefined ? "" : `-${start + limit - 1}`;
  return `${path}:${start}${end}`;
}

export function registerBuiltInToolRendering(pi: ExtensionAPI): void {
  const initialCwd = process.cwd();

  const initialRead = createReadTool(initialCwd);
  pi.registerTool({
    ...initialRead,
    ...createCodexToolRendering({
      icon: "",
      runningVerb: "Reading",
      completedVerb: "Read",
      argument: readArgument,
      collapsed: "hidden",
    }),
    execute(id, params, signal, onUpdate, ctx) {
      return createReadTool(ctx.cwd).execute(id, params, signal, onUpdate);
    },
  });

  const initialGrep = createGrepTool(initialCwd);
  pi.registerTool({
    ...initialGrep,
    ...createCodexToolRendering({
      icon: "",
      runningVerb: "Searching",
      completedVerb: "Searched",
      argument: (args) => {
        const pattern = typeof args.pattern === "string" ? `"${args.pattern}"` : "";
        const path = typeof args.path === "string" ? ` in ${args.path}` : "";
        return `${pattern}${path}`;
      },
      collapsed: countSummary("match", "matches"),
    }),
    execute(id, params, signal, onUpdate, ctx) {
      return createGrepTool(ctx.cwd).execute(id, params, signal, onUpdate);
    },
  });

  const initialFind = createFindTool(initialCwd);
  pi.registerTool({
    ...initialFind,
    ...createCodexToolRendering({
      icon: "",
      runningVerb: "Finding",
      completedVerb: "Found",
      argument: (args) => {
        const pattern = typeof args.pattern === "string" ? args.pattern : "";
        const path = typeof args.path === "string" ? ` in ${args.path}` : "";
        return `${pattern}${path}`;
      },
      collapsed: countSummary("file"),
    }),
    execute(id, params, signal, onUpdate, ctx) {
      return createFindTool(ctx.cwd).execute(id, params, signal, onUpdate);
    },
  });

  const initialLs = createLsTool(initialCwd);
  pi.registerTool({
    ...initialLs,
    ...createCodexToolRendering({
      icon: "",
      runningVerb: "Listing",
      completedVerb: "Listed",
      argument: (args) => typeof args.path === "string" ? args.path : ".",
      collapsed: countSummary("entry", "entries"),
    }),
    execute(id, params, signal, onUpdate, ctx) {
      return createLsTool(ctx.cwd).execute(id, params, signal, onUpdate);
    },
  });
}
