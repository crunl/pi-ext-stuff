import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { createCodemodeTreeRendering } from "./codemode-tree.ts";

/**
 * Shadow-register `codemode` with tree presentation.
 *
 * Pi has no renderer-only registration API (1.0.0). We take the public
 * `createCodemodeExtension()` factory, run it against a registerTool-capturing
 * proxy so execute/prepareLoadout stay verbatim, and splice in tree renderers.
 *
 * Registering the same tool name from a non-replaceable extension omits
 * `builtin:codemode` (first registration per name wins) — expected, and the
 * reason we never hand-write execute.
 */

type CodemodeExtensionOptions = {
  mode?: "on" | "only";
  inlineBudget?: number;
  models?: boolean;
};

type CreateCodemodeExtension = (options?: CodemodeExtensionOptions) => ExtensionFactory;

type CapturingPi = ExtensionAPI & {
  registerTool: (tool: unknown) => void;
};

function resolveCreateCodemodeExtension(): CreateCodemodeExtension | undefined {
  const factory = (piCodingAgent as unknown as Record<string, unknown>).createCodemodeExtension;
  return typeof factory === "function" ? (factory as CreateCodemodeExtension) : undefined;
}

function captureCodemodeDefinition(
  pi: ExtensionAPI,
  factory: CreateCodemodeExtension,
): Record<string, unknown> | undefined {
  let captured: Record<string, unknown> | undefined;
  const proxy = new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (tool: unknown) => {
          captured = tool as Record<string, unknown>;
        };
      }
      const value = Reflect.get(target, prop, receiver === proxy ? target : receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as CapturingPi;
  factory()(proxy);
  return captured;
}

export function registerCodemodeTreeTool(pi: ExtensionAPI): void {
  const factory = resolveCreateCodemodeExtension();
  if (!factory) {
    // Host older than 0.99 — builtin codemode is absent; nothing to present.
    return;
  }
  const definition = captureCodemodeDefinition(pi, factory);
  if (!definition) return;
  const tree = createCodemodeTreeRendering();
  pi.registerTool({
    ...definition,
    ...tree,
    defaultActive: false,
  } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
}

/** Test seam: run capture against an explicit factory without package probing. */
export function __captureCodemodeDefinitionForTest(
  pi: ExtensionAPI,
  factory: CreateCodemodeExtension,
): Record<string, unknown> | undefined {
  return captureCodemodeDefinition(pi, factory);
}
