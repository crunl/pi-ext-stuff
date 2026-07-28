import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  startHostFilteringProxy,
  type HostFilteringProxy,
} from "./filtering-proxy.ts";
import {
  fingerprintConfig,
  fingerprintValue,
  loadPermissionsConfig,
  type LoadedPermissionsConfig,
  type PermissionsConfig,
} from "./config.ts";
import {
  evaluateDefaultRequest,
  type DefaultDecision,
} from "./default-mode.ts";
import { buildAutoReviewRequest } from "./auto-review-request.ts";
import {
  type AutoReviewer,
  PiAutoReviewer,
} from "./auto-reviewer.ts";
import { reviewAutoPrompt } from "./auto-policy.ts";
import { defaultProtectedWritePaths } from "./filesystem-policy.ts";
import { PermissionModeRuntime } from "./mode-runtime.ts";
import { SandboxExecutionCoordinator } from "./sandbox-coordinator.ts";
import { permissionedBashParameters } from "./shell-permissions.ts";
import {
  createSandboxedBashOperations,
  createSandboxedFileOperations,
  createSandboxRuntimeConfig,
  detectLocalProxyPorts,
  type LocalProxyPorts,
  type SandboxManagerLike,
  withAdditionalWriteRoots,
  withAllowedDomains,
  withLocalProxy,
} from "./sandbox.ts";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export interface RegisterExtensionOptions {
  agentDir?: string;
  sandboxManager?: SandboxManagerLike;
  bashToolFactory?: typeof createBashTool;
  localProxyPorts?: LocalProxyPorts;
  filteringProxyFactory?: (
    approvedHosts: readonly string[],
    upstream: LocalProxyPorts,
    deniedHosts?: readonly string[],
  ) => Promise<HostFilteringProxy>;
  sandboxCoordinator?: Pick<
    SandboxExecutionCoordinator,
    "runShared" | "runExclusive"
  >;
  autoReviewer?: AutoReviewer;
}

interface ApprovedCall {
  authority: "user" | "auto-review";
  mode: "default" | "auto";
  configFingerprint: string;
  cwd: string;
  requestFingerprint: string;
}

export function registerExtension(
  pi: ExtensionAPI,
  options: RegisterExtensionOptions = {},
): void {
  const agentDir = options.agentDir ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const sandboxManager = options.sandboxManager ?? SandboxManager;
  const bashToolFactory = options.bashToolFactory ?? createBashTool;
  const baseBash = bashToolFactory(process.cwd());
  const baseWrite = createWriteTool(process.cwd());
  const baseEdit = createEditTool(process.cwd());
  const localProxyPorts = options.localProxyPorts ?? detectLocalProxyPorts();
  const filteringProxyFactory = options.filteringProxyFactory ?? startHostFilteringProxy;
  const sandboxCoordinator = options.sandboxCoordinator ?? new SandboxExecutionCoordinator();
  const autoReviewer = options.autoReviewer ?? new PiAutoReviewer();
  let loaded: LoadedPermissionsConfig | undefined;
  let loadedKey: string | undefined;
  let activationFailure: { key: string; error: Error } | undefined;
  let modeRuntime: PermissionModeRuntime | undefined;
  const approvedCalls = new Map<string, ApprovedCall>();
  const approvedNetworkHosts = new Map<string, string[]>();
  const approvedWriteRoots = new Map<string, string[]>();
  let baseSandboxConfig: SandboxRuntimeConfig | undefined;
  let sandboxState:
    | { kind: "pending" }
    | { kind: "disabled" }
    | { kind: "ready"; profile: LoadedPermissionsConfig["config"]["sandbox"]["profile"] }
    | { kind: "failed"; error: string } = { kind: "pending" };

  const setDefaultStatus = (ctx: Pick<ExtensionContext, "ui">): void => {
    ctx.ui.setStatus("pi-permissions", modeRuntime?.statusLabel ?? "Default");
  };

  const oneCallWriteRoots = (
    event: ToolCallEvent,
    cwd: string,
  ): string[] => {
    const tool = event.toolName.toLowerCase();
    if (tool !== "write" && tool !== "edit") return [];
    const input = event.input as Record<string, unknown>;
    if (typeof input.path !== "string") return [];
    const path = isAbsolute(input.path) ? resolve(input.path) : resolve(cwd, input.path);
    return [path, dirname(path)];
  };

  const ensureModeRuntime = (
    config: PermissionsConfig,
  ): PermissionModeRuntime => {
    modeRuntime ??= new PermissionModeRuntime(
      config,
      pi.appendEntry.bind(pi),
    );
    return modeRuntime;
  };

  const grantApprovedCall = (
    event: ToolCallEvent,
    decision: Extract<DefaultDecision, { action: "prompt" }>,
    config: PermissionsConfig,
    cwd: string,
    authority: "user" | "auto-review",
  ): void => {
    if (!event.toolCallId) return;
    const runtime = ensureModeRuntime(config);
    const mode = runtime.mode;
    if (mode === "plan") throw new Error("Plan mode is not implemented");
    approvedCalls.set(event.toolCallId, {
      authority,
      mode,
      configFingerprint: fingerprintConfig(config),
      cwd: resolve(cwd),
      requestFingerprint: fingerprintValue({
        tool: event.toolName.toLowerCase(),
        input: event.input,
      }),
    });
    if (decision.networkHosts?.length) {
      approvedNetworkHosts.set(event.toolCallId, [...decision.networkHosts]);
    }
    const writeRoots = [...new Set([
      ...oneCallWriteRoots(event, cwd),
      ...(decision.filesystemWriteRoots ?? []),
    ])];
    if (writeRoots.length > 0) {
      approvedWriteRoots.set(event.toolCallId, writeRoots);
    }
  };

  const configKey = (
    ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
  ): string => {
    const projectTrusted = ctx.isProjectTrusted();
    return `${ctx.cwd}\0${projectTrusted}`;
  };

  const activateConfigUnlocked = async (
    ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "ui" | "hasUI">,
    force = false,
  ): Promise<LoadedPermissionsConfig> => {
    const key = configKey(ctx);
    if (!force && loaded && loadedKey === key) return loaded;
    if (!force && activationFailure?.key === key) throw activationFailure.error;

    const candidate = await loadPermissionsConfig(
      ctx.cwd,
      agentDir,
      ctx.isProjectTrusted(),
    );
    const previous = {
      loaded,
      loadedKey,
      baseSandboxConfig,
      sandboxState,
    };
    const candidateSandbox = candidate.config.sandbox.enabled
      ? createSandboxRuntimeConfig(
          candidate.config.sandbox,
          ctx.cwd,
          defaultProtectedWritePaths(ctx.cwd, agentDir),
        )
      : undefined;

    try {
      await sandboxManager.reset();
      if (candidateSandbox) await sandboxManager.initialize(candidateSandbox);
    } catch (error: unknown) {
      try {
        await sandboxManager.reset();
        if (previous.sandboxState.kind === "ready" && previous.baseSandboxConfig) {
          await sandboxManager.initialize(previous.baseSandboxConfig);
          sandboxState = previous.sandboxState;
        } else if (previous.sandboxState.kind === "disabled") {
          sandboxState = previous.sandboxState;
        } else {
          const message = error instanceof Error ? error.message : String(error);
          sandboxState = { kind: "failed", error: message };
        }
      } catch (rollbackError: unknown) {
        const message = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        sandboxState = { kind: "failed", error: `rollback failed: ${message}` };
      }
      loaded = previous.loaded;
      loadedKey = previous.loadedKey;
      baseSandboxConfig = previous.baseSandboxConfig;
      if (!previous.loaded) {
        const message = error instanceof Error ? error.message : String(error);
        activationFailure = {
          key,
          error: new Error(`pi-permissions sandbox unavailable: ${message}`),
        };
      }
      throw error;
    }

    activationFailure = undefined;
    if (force) {
      approvedCalls.clear();
      approvedNetworkHosts.clear();
      approvedWriteRoots.clear();
    }
    loaded = candidate;
    loadedKey = key;
    baseSandboxConfig = candidateSandbox;
    sandboxState = candidateSandbox
      ? { kind: "ready", profile: candidate.config.sandbox.profile }
      : { kind: "disabled" };
    setDefaultStatus(ctx);
    return candidate;
  };

  const activateConfig = (
    ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "ui" | "hasUI">,
    force = false,
  ): Promise<LoadedPermissionsConfig> =>
    sandboxCoordinator.runExclusive(() => activateConfigUnlocked(ctx, force));

  const assertExecutionAuthorized = async (
    tool: string,
    id: string,
    input: Record<string, unknown>,
    ctx: Pick<ExtensionContext, "cwd">,
  ): Promise<void> => {
    const approval = approvedCalls.get(id);
    approvedCalls.delete(id);
    const approved = approval !== undefined
      && approval.cwd === resolve(ctx.cwd)
      && approval.configFingerprint === fingerprintConfig(loaded!.config)
      && approval.mode === modeRuntime?.mode
      && approval.requestFingerprint === fingerprintValue({
        tool: tool.toLowerCase(),
        input,
      });
    const currentDecision = await evaluateDefaultRequest(
      tool,
      input,
      ctx.cwd,
      loaded!.config,
      defaultProtectedWritePaths(ctx.cwd, agentDir),
    );
    if (
      currentDecision.action === "block"
      || currentDecision.action === "prompt" && !approved
    ) {
      throw new Error("pi-permissions: call is no longer authorized; request approval again");
    }
  };

  const sandboxOperations = (
    customConfig?: SandboxRuntimeConfig,
  ): BashOperations => {
    if (sandboxState.kind !== "ready") {
      const reason = sandboxState.kind === "failed"
        ? sandboxState.error
        : `sandbox is ${sandboxState.kind}`;
      throw new Error(`pi-permissions sandbox unavailable: ${reason}`);
    }
    return createSandboxedBashOperations(sandboxManager, customConfig);
  };

  const sandboxFileOperations = (
    writeRoots: readonly string[],
    signal?: AbortSignal,
  ) => {
    if (sandboxState.kind !== "ready" || !baseSandboxConfig) {
      const reason = sandboxState.kind === "failed"
        ? sandboxState.error
        : `sandbox is ${sandboxState.kind}`;
      throw new Error(`pi-permissions sandbox unavailable: ${reason}`);
    }
    return createSandboxedFileOperations(
      sandboxManager,
      baseSandboxConfig,
      writeRoots,
      signal,
    );
  };

  pi.registerTool({
    ...baseBash,
    label: "bash (sandboxed)",
    description: `${baseBash.description} To write outside the active sandbox, request sandbox_permissions="with_additional_permissions", list the minimum additional_permissions.file_system.write roots, and provide justification.`,
    promptGuidelines: [
      "When a command must write outside the workspace, request only the minimum additional filesystem write roots and explain why.",
    ],
    parameters: permissionedBashParameters,
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      await activateConfig(ctx);
      const needsExclusiveLease = (approvedNetworkHosts.get(id)?.length ?? 0) > 0;

      const executeWithSnapshot = async (
        allowNetworkEscalation: boolean,
      ) => {
        const networkHosts = approvedNetworkHosts.get(id) ?? [];
        approvedNetworkHosts.delete(id);
        const writeRoots = approvedWriteRoots.get(id) ?? [];
        approvedWriteRoots.delete(id);
        await assertExecutionAuthorized(
          "bash",
          id,
          params as Record<string, unknown>,
          ctx,
        );

        if (!loaded?.config.sandbox.enabled) {
          return bashToolFactory(ctx.cwd).execute(id, params, signal, onUpdate);
        }
        if (sandboxState.kind !== "ready" || !baseSandboxConfig) {
          const reason = sandboxState.kind === "failed"
            ? sandboxState.error
            : `sandbox is ${sandboxState.kind}`;
          throw new Error(`pi-permissions sandbox unavailable: ${reason}`);
        }

        const baseConfig = baseSandboxConfig;
        let commandConfig = writeRoots.length > 0
          ? withAdditionalWriteRoots(baseConfig, writeRoots)
          : baseConfig;
        let filteringProxy: HostFilteringProxy | undefined;
        try {
          if (networkHosts.length > 0) {
            if (!allowNetworkEscalation) {
              throw new Error("pi-permissions network escalation requires an exclusive sandbox lease");
            }
            const allowedDomains = [
              ...new Set([...baseConfig.network.allowedDomains, ...networkHosts]),
            ];
            const hasLocalProxy = Boolean(localProxyPorts.http || localProxyPorts.socks);
            if (hasLocalProxy) {
              filteringProxy = await filteringProxyFactory(
                allowedDomains,
                localProxyPorts,
                baseConfig.network.deniedDomains,
              );
            }
            commandConfig = filteringProxy
              ? withLocalProxy(commandConfig, filteringProxy.ports, allowedDomains)
              : withAllowedDomains(commandConfig, allowedDomains);
            await sandboxManager.reset();
            await sandboxManager.initialize(commandConfig);
          }

          const sandboxedBash = bashToolFactory(ctx.cwd, {
            operations: sandboxOperations(commandConfig),
          });
          return await sandboxedBash.execute(id, params, signal, onUpdate);
        } finally {
          if (networkHosts.length > 0) {
            try {
              await sandboxManager.reset();
              await sandboxManager.initialize(baseConfig);
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              sandboxState = { kind: "failed", error: message };
              if (ctx.hasUI) {
                ctx.ui.notify(`pi-permissions sandbox 恢复失败：${message}`, "error");
              }
            } finally {
              await filteringProxy?.close();
            }
          }
        }
      };

      if (needsExclusiveLease) {
        return sandboxCoordinator.runExclusive(
          () => executeWithSnapshot(true),
          signal,
        );
      }
      return sandboxCoordinator.runShared(
        () => executeWithSnapshot(false),
        signal,
      );
    },
  });

  pi.registerTool({
    ...baseWrite,
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      await activateConfig(ctx);
      return sandboxCoordinator.runShared(async () => {
        const writeRoots = approvedWriteRoots.get(id) ?? [];
        approvedWriteRoots.delete(id);
        await assertExecutionAuthorized(
          "write",
          id,
          params as Record<string, unknown>,
          ctx,
        );
        if (!loaded?.config.sandbox.enabled) {
          return createWriteTool(ctx.cwd).execute(id, params, signal, onUpdate);
        }
        const tool = createWriteTool(ctx.cwd, {
          operations: sandboxFileOperations(writeRoots, signal),
        });
        return tool.execute(id, params, signal, onUpdate);
      }, signal);
    },
  });

  pi.registerTool({
    ...baseEdit,
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      await activateConfig(ctx);
      return sandboxCoordinator.runShared(async () => {
        const writeRoots = approvedWriteRoots.get(id) ?? [];
        approvedWriteRoots.delete(id);
        await assertExecutionAuthorized(
          "edit",
          id,
          params as Record<string, unknown>,
          ctx,
        );
        if (!loaded?.config.sandbox.enabled) {
          return createEditTool(ctx.cwd).execute(id, params, signal, onUpdate);
        }
        const tool = createEditTool(ctx.cwd, {
          operations: sandboxFileOperations(writeRoots, signal),
        });
        return tool.execute(id, params, signal, onUpdate);
      }, signal);
    },
  });

  const reportConfigError = (ctx: ExtensionContext, error: unknown): ToolCallEventResult => {
    const message = error instanceof Error ? error.message : String(error);
    setDefaultStatus(ctx);
    if (ctx.hasUI) ctx.ui.notify(`pi-permissions 配置错误：${message}`, "error");
    return { block: true, reason: `pi-permissions configuration error: ${message}` };
  };

  const requestHumanApproval = async (
    event: ToolCallEvent,
    decision: Extract<DefaultDecision, { action: "prompt" }>,
    config: PermissionsConfig,
    ctx: ExtensionContext,
    options: { fallbackReason?: string } = {},
  ): Promise<ToolCallEventResult | void> => {
    if (!ctx.hasUI) {
      const fallback = options.fallbackReason
        ? `; Auto reviewer failed: ${options.fallbackReason}`
        : "";
      return {
        block: true,
        reason: `pi-permissions: ${decision.risk} operation requires interactive approval${fallback}`,
      };
    }
    const runtime = ensureModeRuntime(config);
    if (!runtime.beginHumanApproval()) {
      return {
        block: true,
        reason: "pi-permissions: another approval is already active",
      };
    }

    try {
      const approved = await ctx.ui.confirm(
        `pi-permissions · ${decision.risk}`,
        `${event.toolName}: ${decision.summary}\n\n${decision.reason}${
          decision.networkHosts?.length
            ? `\n\nNetwork for this command: ${decision.networkHosts.join(", ")}`
            : ""
        }${
          decision.filesystemWriteRoots?.length
            ? `\n\nFilesystem for this command: ${decision.filesystemWriteRoots.join(", ")}`
            : ""
        }${
          decision.justification
            ? `\n\nJustification: ${decision.justification}`
            : ""
        }${
          options.fallbackReason
            ? `\n\nAuto reviewer fallback: ${options.fallbackReason}`
            : ""
        }`,
      );
      if (approved) {
        grantApprovedCall(event, decision, config, ctx.cwd, "user");
        return;
      }
      return {
        block: true,
        reason: `pi-permissions: user denied ${decision.risk} operation`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        block: true,
        reason: `pi-permissions approval failed: ${message}`,
      };
    } finally {
      runtime.endHumanApproval();
      setDefaultStatus(ctx);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    approvedCalls.clear();
    approvedNetworkHosts.clear();
    approvedWriteRoots.clear();
    try {
      const result = await activateConfig(ctx, true);
      modeRuntime = new PermissionModeRuntime(
        result.config,
        pi.appendEntry.bind(pi),
      );
      modeRuntime.restore(ctx.sessionManager.getBranch(), result.config);
      setDefaultStatus(ctx);
    } catch (error: unknown) {
      reportConfigError(ctx, error);
    }
  });

  pi.on("session_shutdown", async () => {
    await sandboxCoordinator.runExclusive(async () => {
      sandboxState = { kind: "pending" };
      approvedCalls.clear();
      approvedNetworkHosts.clear();
      approvedWriteRoots.clear();
      await sandboxManager.reset();
    });
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | void> => {
    let result: LoadedPermissionsConfig;
    try {
      result = await activateConfig(ctx);
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
        defaultProtectedWritePaths(ctx.cwd, agentDir),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `pi-permissions failed closed: ${message}` };
    }

    if (decision.action === "allow") return;
    if (decision.action === "block") {
      return { block: true, reason: `pi-permissions: ${decision.reason}` };
    }
    const runtime = ensureModeRuntime(result.config);
    if (runtime.mode === "auto" && !runtime.autoState.paused) {
      const id = event.toolCallId;
      if (!id) {
        return {
          block: true,
          reason: "pi-permissions: Auto review requires a tool-call ID",
        };
      }
      if (!runtime.beginReview(id)) {
        return { block: true, reason: "pi-permissions: duplicate Auto review" };
      }
      try {
        const request = buildAutoReviewRequest(
          event,
          decision,
          ctx.cwd,
          result.config.sandbox.profile,
          ctx.sessionManager.getBranch(),
        );
        const auto = await reviewAutoPrompt(
          autoReviewer,
          request,
          {
            modelRegistry: ctx.modelRegistry,
            activeModel: ctx.model,
            reviewer: result.config.reviewer,
          },
          runtime.autoState,
          result.config.reviewer?.maxConsecutiveDenials ?? 3,
          ctx.signal,
        );
        runtime.applyAutoState(auto.state);
        if (auto.action === "approve") {
          grantApprovedCall(
            event,
            decision,
            result.config,
            ctx.cwd,
            "auto-review",
          );
          return;
        }
        if (auto.action === "deny") {
          return {
            block: true,
            reason: `pi-permissions Auto denied: ${auto.review.rationale} Take a materially safer approach.`,
          };
        }
        return requestHumanApproval(event, decision, result.config, ctx, {
          fallbackReason: auto.error.message,
        });
      } finally {
        runtime.endReview(id);
      }
    }
    return requestHumanApproval(event, decision, result.config, ctx);
  });

  pi.registerCommand("default", {
    description: "Activate pi-permissions Default mode",
    handler: async (_args, ctx) => {
      try {
        const result = await activateConfig(ctx, true);
        ensureModeRuntime(result.config).activate("default", {
          idle: ctx.isIdle(),
        });
        setDefaultStatus(ctx);
        ctx.ui.notify("pi-permissions: Default mode 已启用", "info");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setDefaultStatus(ctx);
        ctx.ui.notify(
          `pi-permissions 配置重载失败；继续使用上一份有效策略：${message}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("permissions", {
    description: "Show the active pi-permissions policy",
    handler: async (_args, ctx) => {
      try {
        const result = await activateConfig(ctx, true);
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
          `${modeRuntime?.statusLabel ?? "Default"} · approval gate on · ${sandboxSummary} · ${config.rules.length} rules · write roots: ${config.sandbox.filesystem.allowWrite.join(", ")}`,
          "info",
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setDefaultStatus(ctx);
        ctx.ui.notify(
          `pi-permissions 配置重载失败；继续使用上一份有效策略：${message}`,
          "error",
        );
      }
    },
  });
}
