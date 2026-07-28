import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadPermissionsConfig,
  type LoadedPermissionsConfig,
} from "./config.ts";
import { evaluateDefaultRequest } from "./default-mode.ts";

export interface RegisterExtensionOptions {
  agentDir?: string;
}

export function registerExtension(
  pi: ExtensionAPI,
  options: RegisterExtensionOptions = {},
): void {
  const agentDir = options.agentDir ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  let loaded: LoadedPermissionsConfig | undefined;
  let loadedKey: string | undefined;
  let approvalActive = false;

  const setDefaultStatus = (ctx: Pick<ExtensionContext, "ui">): void => {
    ctx.ui.setStatus("pi-permissions", "Default");
  };

  const getConfig = async (
    ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
    force = false,
  ): Promise<LoadedPermissionsConfig> => {
    const projectTrusted = ctx.isProjectTrusted();
    const key = `${ctx.cwd}\0${projectTrusted}`;
    if (!force && loaded && loadedKey === key) return loaded;
    loaded = await loadPermissionsConfig(ctx.cwd, agentDir, projectTrusted);
    loadedKey = key;
    return loaded;
  };

  const reportConfigError = (ctx: ExtensionContext, error: unknown): ToolCallEventResult => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.setStatus("pi-permissions", "Default · config error");
    if (ctx.hasUI) ctx.ui.notify(`pi-permissions 配置错误：${message}`, "error");
    return { block: true, reason: `pi-permissions configuration error: ${message}` };
  };

  pi.on("session_start", async (_event, ctx) => {
    approvalActive = false;
    try {
      const result = await getConfig(ctx, true);
      setDefaultStatus(ctx);
      if (result.config.defaultMode !== "default" && ctx.hasUI) {
        ctx.ui.notify("pi-permissions 当前仅启用 Default mode；已忽略其他 defaultMode。", "warning");
      }
    } catch (error: unknown) {
      reportConfigError(ctx, error);
    }
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | void> => {
    let result: LoadedPermissionsConfig;
    try {
      result = await getConfig(ctx);
    } catch (error: unknown) {
      return reportConfigError(ctx, error);
    }

    let decision;
    try {
      decision = await evaluateDefaultRequest(
        event.toolName,
        event.input as Record<string, unknown>,
        ctx.cwd,
        result.config,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `pi-permissions failed closed: ${message}` };
    }

    if (decision.action === "allow") return;
    if (decision.action === "block") {
      return { block: true, reason: `pi-permissions: ${decision.reason}` };
    }
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `pi-permissions: ${decision.risk} operation requires interactive approval`,
      };
    }
    if (approvalActive) {
      return { block: true, reason: "pi-permissions: another approval is already active" };
    }

    approvalActive = true;
    ctx.ui.setStatus("pi-permissions", `Default · ${decision.risk} approval`);
    try {
      const approved = await ctx.ui.confirm(
        `pi-permissions · ${decision.risk}`,
        `${event.toolName}: ${decision.summary}\n\n${decision.reason}`,
      );
      if (approved) return;
      return { block: true, reason: `pi-permissions: user denied ${decision.risk} operation` };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `pi-permissions approval failed: ${message}` };
    } finally {
      approvalActive = false;
      setDefaultStatus(ctx);
    }
  });

  pi.registerCommand("default", {
    description: "Activate pi-permissions Default mode",
    handler: async (_args, ctx) => {
      try {
        await getConfig(ctx, true);
        setDefaultStatus(ctx);
        ctx.ui.notify("pi-permissions: Default mode 已启用", "info");
      } catch (error: unknown) {
        reportConfigError(ctx, error);
      }
    },
  });

  pi.registerCommand("permissions", {
    description: "Show the active pi-permissions policy",
    handler: async (_args, ctx) => {
      try {
        const result = await getConfig(ctx, true);
        const config = result.config;
        setDefaultStatus(ctx);
        ctx.ui.notify(
          `Default · approval gate on · sandbox not connected · ${config.rules.length} rules · write roots: ${config.sandbox.filesystem.allowWrite.join(", ")}`,
          "info",
        );
      } catch (error: unknown) {
        reportConfigError(ctx, error);
      }
    },
  });
}
