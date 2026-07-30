import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
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
  getLanguageFromPath,
} from "@earendil-works/pi-coding-agent";
import {
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  createCodexToolRendering,
  createEditDiffBox,
  summarizeEditDiff,
} from "../../pi-core/index.ts";
import { AutoApprovalLedger } from "./auto-approval-ledger.ts";
import { reviewAutoPrompt } from "./auto-policy.ts";
import { buildAutoReviewRequest } from "./auto-review-request.ts";
import {
  type AutoReviewer,
  type AutoReviewerFailureKind,
  PiAutoReviewer,
} from "./auto-reviewer.ts";
import {
  fingerprintConfig,
  fingerprintValue,
  type LoadedPermissionsConfig,
  loadPermissionsConfig,
  type PermissionsConfig,
} from "./config.ts";
import { type DefaultDecision, evaluateDefaultRequest } from "./default-mode.ts";
import { defaultProtectedWritePaths } from "./filesystem-policy.ts";
import { type HostFilteringProxy, startHostFilteringProxy } from "./filtering-proxy.ts";
import type { GuardianReviewSessionManager } from "./guardian-session.ts";
import { PermissionModeRuntime } from "./mode-runtime.ts";
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
import { SandboxExecutionCoordinator } from "./sandbox-coordinator.ts";
import { permissionedBashParameters } from "./shell-permissions.ts";
import { shiftTabAvailability } from "./shortcut-config.ts";

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
  sandboxCoordinator?: Pick<SandboxExecutionCoordinator, "runShared" | "runExclusive">;
  autoReviewer?: AutoReviewer;
  guardianSessionManager?: GuardianReviewSessionManager;
}

interface ApprovedCall {
  authority: "user" | "auto-review";
  mode: "default" | "auto" | "user-transition";
  configFingerprint: string;
  cwd: string;
  requestFingerprint: string;
}

const DEFAULT_ALLOW_ONCE_CHOICE = "Allow Once";
const DEFAULT_ALLOW_AND_AUTO_CHOICE = "Allow, switch future approvals to Auto";
const DEFAULT_DENY_CHOICE = "Deny";
const guardianFallbackNoticeKeys = new Set<string>();

function countWrittenLines(content: string): number {
  if (content.length === 0) return 0;
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").length;
  return normalized.endsWith("\n") ? lines - 1 : lines;
}

export function registerExtension(pi: ExtensionAPI, options: RegisterExtensionOptions = {}): void {
  const agentDir = options.agentDir ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const sandboxManager = options.sandboxManager ?? SandboxManager;
  const bashToolFactory = options.bashToolFactory ?? createBashTool;
  const baseBash = bashToolFactory(process.cwd());
  const baseWrite = createWriteTool(process.cwd());
  const baseEdit = createEditTool(process.cwd());
  const localProxyPorts = options.localProxyPorts ?? detectLocalProxyPorts();
  const filteringProxyFactory = options.filteringProxyFactory ?? startHostFilteringProxy;
  const sandboxCoordinator = options.sandboxCoordinator ?? new SandboxExecutionCoordinator();
  const autoReviewer =
    options.autoReviewer ?? new PiAutoReviewer(undefined, options.guardianSessionManager);
  let loaded: LoadedPermissionsConfig | undefined;
  let loadedKey: string | undefined;
  let activationFailure: { key: string; error: Error } | undefined;
  let modeRuntime: PermissionModeRuntime | undefined;
  let shortcutWarningShown = false;
  const trustedUserMessages: string[] = [];
  const autoApprovalLedger = new AutoApprovalLedger();
  const reviewControllers = new Map<string, AbortController>();
  let modeMutationTail: Promise<void> = Promise.resolve();
  let modeMutationGeneration = 0;
  const approvedCalls = new Map<string, ApprovedCall>();
  const approvedNetworkHosts = new Map<string, string[]>();
  const approvedWriteRoots = new Map<string, string[]>();
  let permissionContextEpoch = 0;
  let baseSandboxConfig: SandboxRuntimeConfig | undefined;
  let sandboxState:
    | { kind: "pending" }
    | { kind: "disabled" }
    | { kind: "ready"; profile: LoadedPermissionsConfig["config"]["sandbox"]["profile"] }
    | { kind: "failed"; error: string } = { kind: "pending" };

  const revokeApprovedCall = (toolCallId: string | undefined): void => {
    if (!toolCallId) return;
    approvedCalls.delete(toolCallId);
    approvedNetworkHosts.delete(toolCallId);
    approvedWriteRoots.delete(toolCallId);
  };

  const setDefaultStatus = (ctx: Pick<ExtensionContext, "ui">): void => {
    ctx.ui.setStatus("pi-permissions", modeRuntime?.statusLabel ?? "Default");
  };

  const runModeMutation = <T>(
    operation: (generation: number) => Promise<T>,
  ): Promise<T | undefined> => {
    const generation = modeMutationGeneration;
    const execute = async (): Promise<T | undefined> => {
      if (generation !== modeMutationGeneration) return undefined;
      return operation(generation);
    };
    const result = modeMutationTail.then(execute, execute);
    modeMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const restoreModeState = (
    ctx: Pick<ExtensionContext, "sessionManager">,
    config: PermissionsConfig,
  ): void => {
    if (!modeRuntime) return;
    modeRuntime.restore(ctx.sessionManager.getBranch(), config);
  };

  const invalidatePermissionContext = (reason: string): void => {
    permissionContextEpoch += 1;
    for (const controller of reviewControllers.values()) {
      controller.abort(new Error(reason));
    }
    reviewControllers.clear();
    modeRuntime?.cancelReviews();
    approvedCalls.clear();
    approvedNetworkHosts.clear();
    approvedWriteRoots.clear();
    autoApprovalLedger.clear();
    autoReviewer.invalidateSession();
  };

  const resetBranchPermissionContext = (reason: string): void => {
    modeMutationGeneration += 1;
    trustedUserMessages.length = 0;
    invalidatePermissionContext(reason);
  };

  const oneCallWriteRoots = (event: ToolCallEvent, cwd: string): string[] => {
    const tool = event.toolName.toLowerCase();
    if (tool !== "write" && tool !== "edit") return [];
    const input = event.input as Record<string, unknown>;
    if (typeof input.path !== "string") return [];
    const path = isAbsolute(input.path) ? resolve(input.path) : resolve(cwd, input.path);
    return [path, dirname(path)];
  };

  const ensureModeRuntime = (config: PermissionsConfig): PermissionModeRuntime => {
    modeRuntime ??= new PermissionModeRuntime(config, pi.appendEntry.bind(pi));
    return modeRuntime;
  };

  const grantApprovedCall = (
    event: ToolCallEvent,
    decision: Extract<DefaultDecision, { action: "prompt" }>,
    config: PermissionsConfig,
    cwd: string,
    authority: "user" | "auto-review",
    mode: ApprovedCall["mode"],
  ): void => {
    if (!event.toolCallId) return;
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
    const writeRoots = [
      ...new Set([...oneCallWriteRoots(event, cwd), ...(decision.filesystemWriteRoots ?? [])]),
    ];
    if (writeRoots.length > 0) {
      approvedWriteRoots.set(event.toolCallId, writeRoots);
    }
  };

  const configKey = (ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): string => {
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

    const candidate = await loadPermissionsConfig(ctx.cwd, agentDir, ctx.isProjectTrusted());
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
        const message =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
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
      invalidatePermissionContext("permission context changed");
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
    const activeConfig = loaded?.config;
    if (!activeConfig) {
      throw new Error("pi-permissions: active configuration is unavailable");
    }
    const approval = approvedCalls.get(id);
    approvedCalls.delete(id);
    const approved =
      approval !== undefined &&
      approval.cwd === resolve(ctx.cwd) &&
      approval.configFingerprint === fingerprintConfig(activeConfig) &&
      (approval.mode === "user-transition" || approval.mode === modeRuntime?.mode) &&
      approval.requestFingerprint ===
        fingerprintValue({
          tool: tool.toLowerCase(),
          input,
        });
    const currentDecision = await evaluateDefaultRequest(
      tool,
      input,
      ctx.cwd,
      activeConfig,
      defaultProtectedWritePaths(ctx.cwd, agentDir),
    );
    if (currentDecision.action === "block" || (currentDecision.action === "prompt" && !approved)) {
      throw new Error("pi-permissions: call is no longer authorized; request approval again");
    }
  };

  const sandboxOperations = (customConfig?: SandboxRuntimeConfig): BashOperations => {
    if (sandboxState.kind !== "ready") {
      const reason =
        sandboxState.kind === "failed" ? sandboxState.error : `sandbox is ${sandboxState.kind}`;
      throw new Error(`pi-permissions sandbox unavailable: ${reason}`);
    }
    return createSandboxedBashOperations(sandboxManager, customConfig);
  };

  const sandboxFileOperations = (writeRoots: readonly string[], signal?: AbortSignal) => {
    if (sandboxState.kind !== "ready" || !baseSandboxConfig) {
      const reason =
        sandboxState.kind === "failed" ? sandboxState.error : `sandbox is ${sandboxState.kind}`;
      throw new Error(`pi-permissions sandbox unavailable: ${reason}`);
    }
    return createSandboxedFileOperations(sandboxManager, baseSandboxConfig, writeRoots, signal);
  };

  pi.registerTool({
    ...baseBash,
    ...createCodexToolRendering({
      icon: "",
      runningVerb: "Running",
      completedVerb: "Ran",
      argument: (args) => (typeof args.command === "string" ? args.command : ""),
      collapsed: "preview",
      transformOutput: compactBashStatusSpacing,
    }),
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

      const executeWithSnapshot = async (allowNetworkEscalation: boolean) => {
        const networkHosts = approvedNetworkHosts.get(id) ?? [];
        approvedNetworkHosts.delete(id);
        const writeRoots = approvedWriteRoots.get(id) ?? [];
        approvedWriteRoots.delete(id);
        await assertExecutionAuthorized("bash", id, params as Record<string, unknown>, ctx);

        if (!loaded?.config.sandbox.enabled) {
          return bashToolFactory(ctx.cwd).execute(id, params, signal, onUpdate);
        }
        if (sandboxState.kind !== "ready" || !baseSandboxConfig) {
          const reason =
            sandboxState.kind === "failed" ? sandboxState.error : `sandbox is ${sandboxState.kind}`;
          throw new Error(`pi-permissions sandbox unavailable: ${reason}`);
        }

        const baseConfig = baseSandboxConfig;
        let commandConfig =
          writeRoots.length > 0 ? withAdditionalWriteRoots(baseConfig, writeRoots) : baseConfig;
        let filteringProxy: HostFilteringProxy | undefined;
        try {
          if (networkHosts.length > 0) {
            if (!allowNetworkEscalation) {
              throw new Error(
                "pi-permissions network escalation requires an exclusive sandbox lease",
              );
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
        return sandboxCoordinator.runExclusive(() => executeWithSnapshot(true), signal);
      }
      return sandboxCoordinator.runShared(() => executeWithSnapshot(false), signal);
    },
  });

  pi.registerTool({
    ...baseWrite,
    ...createCodexToolRendering({
      icon: "",
      runningVerb: "Writing",
      completedVerb: "Wrote",
      argument: (args) => (typeof args.path === "string" ? args.path : ""),
      collapsed: (_result, args) => {
        const content = typeof args.content === "string" ? args.content : "";
        const lineCount = countWrittenLines(content);
        return lineCount > 0 ? `+${lineCount}` : undefined;
      },
    }),
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      await activateConfig(ctx);
      return sandboxCoordinator.runShared(async () => {
        const writeRoots = approvedWriteRoots.get(id) ?? [];
        approvedWriteRoots.delete(id);
        await assertExecutionAuthorized("write", id, params as Record<string, unknown>, ctx);
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
    ...createCodexToolRendering({
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
    }),
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      await activateConfig(ctx);
      return sandboxCoordinator.runShared(async () => {
        const writeRoots = approvedWriteRoots.get(id) ?? [];
        approvedWriteRoots.delete(id);
        await assertExecutionAuthorized("edit", id, params as Record<string, unknown>, ctx);
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
    options: {
      guardianFailure?: AutoReviewerFailureKind;
    } = {},
  ): Promise<ToolCallEventResult | undefined> => {
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `pi-permissions: ${decision.risk} operation requires interactive approval`,
      };
    }
    const runtime = ensureModeRuntime(config);
    if (!runtime.beginHumanApproval()) {
      return {
        block: true,
        reason: "pi-permissions: another approval is already active",
      };
    }
    const approvalEpoch = permissionContextEpoch;
    let transitionGrantCreated = false;

    try {
      const guardianFailure =
        options.guardianFailure === undefined
          ? ""
          : `Guardian review failed (${options.guardianFailure}); manual approval is required.\n\n`;
      const prompt = `${guardianFailure}pi-permissions · ${decision.risk}\n\n${event.toolName}: ${decision.summary}\n\n${decision.reason}${
        decision.networkHosts?.length
          ? `\n\nNetwork for this command: ${decision.networkHosts.join(", ")}`
          : ""
      }${
        decision.filesystemWriteRoots?.length
          ? `\n\nFilesystem for this command: ${decision.filesystemWriteRoots.join(", ")}`
          : ""
      }${decision.justification ? `\n\nJustification: ${decision.justification}` : ""}`;
      const choice = await ctx.ui.select(prompt, [
        DEFAULT_ALLOW_ONCE_CHOICE,
        DEFAULT_ALLOW_AND_AUTO_CHOICE,
        DEFAULT_DENY_CHOICE,
      ]);
      if (choice === DEFAULT_ALLOW_ONCE_CHOICE || choice === DEFAULT_ALLOW_AND_AUTO_CHOICE) {
        if (permissionContextEpoch !== approvalEpoch) {
          return {
            block: true,
            reason: "pi-permissions: approval context changed before confirmation",
          };
        }
        if (choice === DEFAULT_ALLOW_AND_AUTO_CHOICE) {
          grantApprovedCall(event, decision, config, ctx.cwd, "user", "user-transition");
          transitionGrantCreated = true;
          runtime.activate("auto");
          setDefaultStatus(ctx);
          ctx.ui.notify("pi-permissions: Auto mode 已启用", "info");
          return;
        }
        const approvalMode = runtime.mode === "auto" ? "auto" : "default";
        grantApprovedCall(event, decision, config, ctx.cwd, "user", approvalMode);
        return;
      }
      return {
        block: true,
        reason: `pi-permissions: user denied ${decision.risk} operation`,
      };
    } catch (error: unknown) {
      if (transitionGrantCreated) {
        revokeApprovedCall(event.toolCallId);
        return {
          block: true,
          reason: "pi-permissions approval failed",
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        block: true,
        reason: `pi-permissions approval failed: ${message}`,
      };
    } finally {
      runtime.endHumanApproval();
      if (!transitionGrantCreated) setDefaultStatus(ctx);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    shortcutWarningShown = false;
    resetBranchPermissionContext("session changed");
    try {
      const result = await activateConfig(ctx, true);
      modeRuntime = new PermissionModeRuntime(result.config, pi.appendEntry.bind(pi));
      restoreModeState(ctx, result.config);
      setDefaultStatus(ctx);
      if ((await shiftTabAvailability(agentDir)) === "reserved" && !shortcutWarningShown) {
        shortcutWarningShown = true;
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Shift+Tab 仍由 app.thinking.cycle 占用；请迁移 ~/.pi/agent/keybindings.json 后 /reload",
            "warning",
          );
        }
      }
    } catch (error: unknown) {
      reportConfigError(ctx, error);
    }
  });

  pi.on("session_before_tree", () => {
    resetBranchPermissionContext("session tree changed");
  });

  pi.on("session_tree", (_event, ctx) => {
    resetBranchPermissionContext("session tree changed");
    if (loaded && modeRuntime) {
      restoreModeState(ctx, loaded.config);
      setDefaultStatus(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    modeMutationGeneration += 1;
    invalidatePermissionContext("session shutdown");
    await sandboxCoordinator.runExclusive(async () => {
      sandboxState = { kind: "pending" };
      await sandboxManager.reset();
    });
  });

  pi.on("input", (event) => {
    if ((event.source === "interactive" || event.source === "rpc") && event.text.length > 0) {
      trustedUserMessages.push(event.text);
    }
  });

  pi.on("agent_start", () => {
    modeRuntime?.beginAgentTurn();
  });

  pi.on(
    "tool_call",
    async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
      if (event.toolCallId) {
        approvedCalls.delete(event.toolCallId);
        approvedNetworkHosts.delete(event.toolCallId);
        approvedWriteRoots.delete(event.toolCallId);
      }
      let result: LoadedPermissionsConfig;
      try {
        result = await activateConfig(ctx);
      } catch (error: unknown) {
        return reportConfigError(ctx, error);
      }

      let decision: DefaultDecision;
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
      const effectiveMode = runtime.mode === "auto" ? "auto" : "default";
      if (effectiveMode === "auto" && runtime.autoState.paused) {
        return {
          block: true,
          reason:
            "pi-permissions: Auto review paused after repeated denials; start a new turn or run /auto to resume",
        };
      }
      if (effectiveMode === "auto") {
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
        const reviewController = new AbortController();
        reviewControllers.set(id, reviewController);
        const reviewSignal = ctx.signal
          ? AbortSignal.any([ctx.signal, reviewController.signal])
          : reviewController.signal;
        try {
          const actionFingerprint = fingerprintValue({
            tool: event.toolName.toLowerCase(),
            input: event.input,
          });
          const configFingerprint = fingerprintConfig(result.config);
          const approvalOverride = autoApprovalLedger.takeOverride({
            actionFingerprint,
            cwd: resolve(ctx.cwd),
            configFingerprint,
          });
          const request = buildAutoReviewRequest(
            event,
            decision,
            ctx.cwd,
            result.config.sandbox.profile,
            trustedUserMessages,
            approvalOverride,
          );
          const auto = await reviewAutoPrompt(
            autoReviewer,
            request,
            {
              modelRegistry: ctx.modelRegistry,
              activeModel: ctx.model,
              reviewer: result.config.reviewer,
              guardianSession: {
                cwd: resolve(ctx.cwd),
                configFingerprint,
              },
            },
            runtime.autoState,
            reviewSignal,
          );
          if (reviewSignal.aborted) {
            return {
              block: true,
              reason: "pi-permissions: permission context changed during Auto review",
            };
          }
          if (
            auto.action !== "error" &&
            auto.review.guardian?.source === "active-fallback" &&
            auto.review.guardian.fallbackNotice === "configured-reviewer-unavailable" &&
            ctx.hasUI
          ) {
            const preferred = result.config.reviewer;
            const guardian = auto.review.guardian;
            const noticeKey = fingerprintValue({
              configFingerprint,
              preferredProvider: preferred?.provider,
              preferredModel: preferred?.model,
              activeProvider: guardian.provider,
              activeModel: guardian.model,
            });
            if (!guardianFallbackNoticeKeys.has(noticeKey)) {
              guardianFallbackNoticeKeys.add(noticeKey);
              ctx.ui.notify("Guardian preferred model unavailable; using active model", "warning");
            }
          }
          if (auto.action === "approve") {
            runtime.recordAutoReview("approve");
            grantApprovedCall(
              event,
              decision,
              result.config,
              ctx.cwd,
              "auto-review",
              effectiveMode,
            );
            return;
          }
          if (auto.action === "deny") {
            const autoState = runtime.recordAutoReview("deny");
            autoApprovalLedger.recordDenial({
              tool: event.toolName,
              input: event.input as Record<string, unknown>,
              cwd: resolve(ctx.cwd),
              configFingerprint,
              actionFingerprint,
              summary: decision.summary,
              rationale: auto.review.rationale,
            });
            if (autoState.paused) {
              if (ctx.hasUI) {
                ctx.ui.notify(
                  "Auto-review interrupted this turn after repeated denials",
                  "warning",
                );
              }
              ctx.abort();
            }
            return {
              block: true,
              reason: `pi-permissions Auto denied: ${auto.review.rationale} Do not retry through a workaround or policy circumvention. Take a materially safer approach; otherwise stop and ask the user.`,
            };
          }
          runtime.recordAutoNonDenial();
          if (ctx.hasUI) {
            return requestHumanApproval(event, decision, result.config, ctx, {
              guardianFailure: auto.error.kind,
            });
          }
          return {
            block: true,
            reason: "pi-permissions Auto review failed closed; interactive approval is required",
          };
        } catch {
          if (reviewSignal.aborted) {
            return {
              block: true,
              reason: "pi-permissions: permission context changed during Auto review",
            };
          }
          runtime.recordAutoNonDenial();
          return {
            block: true,
            reason: "pi-permissions Auto review failed closed; the action was not run",
          };
        } finally {
          if (reviewControllers.get(id) === reviewController) {
            reviewControllers.delete(id);
            runtime.endReview(id);
          }
        }
      }
      return requestHumanApproval(event, decision, result.config, ctx);
    },
  );

  const activateMode = async (mode: "default" | "auto", ctx: ExtensionContext): Promise<void> =>
    runModeMutation(async (generation) => {
      try {
        const result = await activateConfig(ctx, ctx.isIdle());
        if (generation !== modeMutationGeneration) return;
        const runtime = ensureModeRuntime(result.config);
        if (runtime.snapshot().configFingerprint !== fingerprintConfig(result.config)) {
          runtime.restore([], result.config);
        }
        runtime.activate(mode);
        invalidatePermissionContext("permission mode changed");
        setDefaultStatus(ctx);
        ctx.ui.notify(`pi-permissions: ${runtime.statusLabel} mode 已启用`, "info");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setDefaultStatus(ctx);
        ctx.ui.notify(`pi-permissions 配置重载失败；继续使用上一份有效策略：${message}`, "error");
      }
    });

  pi.registerCommand("default", {
    description: "Activate pi-permissions Default mode",
    handler: async (_args, ctx) => activateMode("default", ctx),
  });

  pi.registerCommand("auto", {
    description: "Activate pi-permissions Auto mode",
    handler: async (_args, ctx) => activateMode("auto", ctx),
  });

  pi.registerCommand("approve", {
    description: "Approve one exact retry of a recent Auto-review denial",
    handler: async (_args, ctx) => {
      let result: LoadedPermissionsConfig;
      try {
        result = await activateConfig(ctx);
      } catch (error: unknown) {
        reportConfigError(ctx, error);
        return;
      }
      const runtime = ensureModeRuntime(result.config);
      if (runtime.mode !== "auto") {
        ctx.ui.notify("/approve is available only while Auto mode is active", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/approve requires an interactive UI", "warning");
        return;
      }
      const denials = autoApprovalLedger.listDenials().reverse();
      if (denials.length === 0) {
        ctx.ui.notify("No recent Auto-review denials", "info");
        return;
      }
      const choices = denials.map((denial, index) => {
        const summary = denial.summary.replace(/\s+/g, " ").trim().slice(0, 120);
        const rationale = denial.rationale.replace(/\s+/g, " ").trim().slice(0, 160);
        return `${index + 1}. ${denial.tool}: ${summary} — ${rationale}`;
      });
      const choice = await ctx.ui.select("Auto-review Denials", choices);
      if (choice === undefined) return;
      const selectedIndex = choices.indexOf(choice);
      if (selectedIndex < 0) return;
      const denial = denials[selectedIndex];
      if (!denial) return;
      const selected = autoApprovalLedger.approveDenial(denial.id);
      if (!selected) {
        ctx.ui.notify("That Auto-review denial is no longer available", "warning");
        return;
      }
      pi.sendMessage(
        {
          customType: "pi-permissions-auto-override",
          content: [
            "The user approved one retry of this exact Auto-review denial.",
            `Tool: ${selected.tool}`,
            `Input: ${JSON.stringify(selected.input)}`,
            `Working directory: ${selected.cwd}`,
            `Previous denial: ${selected.rationale}`,
            "Retry this exact action once. Do not broaden or alter it; the retry still requires Auto-review.",
          ].join("\n"),
          display: true,
          details: {
            denialId: selected.id,
            actionFingerprint: selected.actionFingerprint,
          },
        },
        { triggerTurn: true },
      );
    },
  });

  const cyclePermissionMode = async (ctx: ExtensionContext): Promise<void> =>
    runModeMutation(async (generation) => {
      try {
        if ((await shiftTabAvailability(agentDir)) !== "available") {
          ctx.ui.notify(
            "Shift+Tab 仍由 app.thinking.cycle 占用；请迁移 ~/.pi/agent/keybindings.json 后 /reload",
            "warning",
          );
          return;
        }
        const result = await activateConfig(ctx);
        if (generation !== modeMutationGeneration) return;
        const runtime = ensureModeRuntime(result.config);
        runtime.cycle();
        invalidatePermissionContext("permission mode changed");
        setDefaultStatus(ctx);
        ctx.ui.notify(`pi-permissions: ${runtime.statusLabel} mode 已启用`, "info");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setDefaultStatus(ctx);
        ctx.ui.notify(`pi-permissions mode 切换失败：${message}`, "error");
      }
    });

  pi.registerShortcut("shift+tab", {
    description: "Cycle pi-permissions mode",
    handler: cyclePermissionMode,
  });

  pi.registerCommand("permissions", {
    description: "Show the active pi-permissions policy",
    handler: async (_args, ctx) => {
      try {
        const result = await activateConfig(ctx, true);
        const config = result.config;
        const runtime = ensureModeRuntime(config);
        if (runtime.snapshot().configFingerprint !== fingerprintConfig(config)) {
          runtime.restore(ctx.sessionManager.getBranch(), config);
        }
        setDefaultStatus(ctx);
        const sandboxSummary =
          sandboxState.kind === "ready"
            ? `${sandboxState.profile} sandbox on`
            : sandboxState.kind === "disabled"
              ? "sandbox off"
              : sandboxState.kind === "failed"
                ? `sandbox error: ${sandboxState.error}`
                : "sandbox pending";
        const reviewerSummary = config.reviewer
          ? `${config.reviewer.provider}/${config.reviewer.model}`
          : "current session model";
        const autoSummary =
          runtime.mode === "auto"
            ? runtime.autoState.paused
              ? "Auto paused"
              : "Auto active"
            : "manual approval";
        ctx.ui.notify(
          `${runtime.statusLabel} · reviewer ${reviewerSummary} · ${sandboxSummary} · ${autoSummary} · ${config.rules.length} rules · write roots: ${config.sandbox.filesystem.allowWrite.join(", ")}`,
          "info",
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setDefaultStatus(ctx);
        ctx.ui.notify(`pi-permissions 配置重载失败；继续使用上一份有效策略：${message}`, "error");
      }
    },
  });
}
