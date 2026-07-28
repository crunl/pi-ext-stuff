import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadPermissionsConfig,
  type LoadedPermissionsConfig,
} from "./config.ts";
import { evaluateDefaultRequest } from "./default-mode.ts";
import {
  createSandboxedBashOperations,
  createSandboxRuntimeConfig,
  detectLocalProxyPorts,
  type LocalProxyPorts,
  OneShotNetworkGrants,
  type SandboxManagerLike,
  withLocalProxy,
} from "./sandbox.ts";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { isPublicNetworkHost } from "./permissions/risk.ts";

export interface RegisterExtensionOptions {
  agentDir?: string;
  sandboxManager?: SandboxManagerLike;
  bashToolFactory?: typeof createBashTool;
  localProxyPorts?: LocalProxyPorts;
}

export function registerExtension(
  pi: ExtensionAPI,
  options: RegisterExtensionOptions = {},
): void {
  const agentDir = options.agentDir ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const sandboxManager = options.sandboxManager ?? SandboxManager;
  const bashToolFactory = options.bashToolFactory ?? createBashTool;
  const baseBash = bashToolFactory(process.cwd());
  const localProxyPorts = options.localProxyPorts ?? detectLocalProxyPorts();
  let loaded: LoadedPermissionsConfig | undefined;
  let loadedKey: string | undefined;
  let approvalActive = false;
  const networkGrants = new OneShotNetworkGrants();
  const approvedNetworkHosts = new Map<string, string[]>();
  let baseSandboxConfig: SandboxRuntimeConfig | undefined;
  let sandboxState:
    | { kind: "pending" }
    | { kind: "disabled" }
    | { kind: "ready"; profile: LoadedPermissionsConfig["config"]["sandbox"]["profile"] }
    | { kind: "failed"; error: string } = { kind: "pending" };

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

  const initializeSandbox = async (
    config: LoadedPermissionsConfig["config"],
    ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
  ): Promise<void> => {
    if (!config.sandbox.enabled) {
      await sandboxManager.reset();
      sandboxState = { kind: "disabled" };
      setDefaultStatus(ctx);
      return;
    }

    sandboxState = { kind: "pending" };
    try {
      await sandboxManager.reset();
      networkGrants.clear();
      baseSandboxConfig = createSandboxRuntimeConfig(config.sandbox, ctx.cwd);
      await sandboxManager.initialize(
        baseSandboxConfig,
        async ({ host }) => networkGrants.has(host) && isPublicNetworkHost(host),
      );
      sandboxState = { kind: "ready", profile: config.sandbox.profile };
      setDefaultStatus(ctx);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sandboxState = { kind: "failed", error: message };
      setDefaultStatus(ctx);
      if (ctx.hasUI) ctx.ui.notify(`pi-permissions sandbox 初始化失败：${message}`, "error");
    }
  };

  const sandboxOperations = (): BashOperations => {
    if (sandboxState.kind !== "ready") {
      const reason = sandboxState.kind === "failed"
        ? sandboxState.error
        : `sandbox is ${sandboxState.kind}`;
      throw new Error(`pi-permissions sandbox unavailable: ${reason}`);
    }
    return createSandboxedBashOperations(sandboxManager);
  };

  pi.registerTool({
    ...baseBash,
    label: "bash (sandboxed)",
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      const result = await getConfig(ctx);
      if (!result.config.sandbox.enabled) {
        return bashToolFactory(ctx.cwd).execute(id, params, signal, onUpdate);
      }
      const networkHosts = approvedNetworkHosts.get(id) ?? [];
      approvedNetworkHosts.delete(id);
      const releaseNetworkGrant = networkGrants.acquire(networkHosts);
      const useLocalProxy = Boolean(networkHosts.length > 0
        && baseSandboxConfig
        && (localProxyPorts.http || localProxyPorts.socks));
      try {
        if (useLocalProxy) {
          await sandboxManager.reset();
          await sandboxManager.initialize(withLocalProxy(baseSandboxConfig!, localProxyPorts));
        }
        const sandboxedBash = bashToolFactory(ctx.cwd, {
          operations: sandboxOperations(),
        });
        return await sandboxedBash.execute(id, params, signal, onUpdate);
      } finally {
        releaseNetworkGrant();
        if (useLocalProxy) {
          try {
            await sandboxManager.reset();
            await sandboxManager.initialize(
              baseSandboxConfig!,
              async ({ host }) => networkGrants.has(host) && isPublicNetworkHost(host),
            );
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            sandboxState = { kind: "failed", error: message };
            if (ctx.hasUI) {
              ctx.ui.notify(`pi-permissions sandbox 恢复失败：${message}`, "error");
            }
          }
        }
      }
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    const result = await getConfig(ctx);
    if (!result.config.sandbox.enabled) return;
    return { operations: sandboxOperations() };
  });

  const reportConfigError = (ctx: ExtensionContext, error: unknown): ToolCallEventResult => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.setStatus("pi-permissions", "Default · config error");
    if (ctx.hasUI) ctx.ui.notify(`pi-permissions 配置错误：${message}`, "error");
    return { block: true, reason: `pi-permissions configuration error: ${message}` };
  };

  pi.on("session_start", async (_event, ctx) => {
    approvalActive = false;
    approvedNetworkHosts.clear();
    try {
      const result = await getConfig(ctx, true);
      await initializeSandbox(result.config, ctx);
      if (result.config.defaultMode !== "default" && ctx.hasUI) {
        ctx.ui.notify("pi-permissions 当前仅启用 Default mode；已忽略其他 defaultMode。", "warning");
      }
    } catch (error: unknown) {
      reportConfigError(ctx, error);
    }
  });

  pi.on("session_shutdown", async () => {
    sandboxState = { kind: "pending" };
    approvedNetworkHosts.clear();
    networkGrants.clear();
    await sandboxManager.reset();
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
    try {
      const approved = await ctx.ui.confirm(
        `pi-permissions · ${decision.risk}`,
        `${event.toolName}: ${decision.summary}\n\n${decision.reason}${
          decision.networkHosts?.length
            ? `\n\nNetwork for this command: ${decision.networkHosts.join(", ")}`
            : ""
        }`,
      );
      if (approved) {
        if (decision.networkHosts?.length && event.toolCallId) {
          approvedNetworkHosts.set(event.toolCallId, decision.networkHosts);
        }
        return;
      }
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
        const sandboxSummary = sandboxState.kind === "ready"
          ? `${sandboxState.profile} sandbox on`
          : sandboxState.kind === "disabled"
            ? "sandbox off"
            : sandboxState.kind === "failed"
              ? `sandbox error: ${sandboxState.error}`
              : "sandbox pending";
        ctx.ui.notify(
          `Default · approval gate on · ${sandboxSummary} · ${config.rules.length} rules · write roots: ${config.sandbox.filesystem.allowWrite.join(", ")}`,
          "info",
        );
      } catch (error: unknown) {
        reportConfigError(ctx, error);
      }
    },
  });
}
