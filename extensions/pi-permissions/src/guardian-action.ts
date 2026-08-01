import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

export type GuardianAction =
  | {
      kind: "shell";
      command: string;
      cwd: string;
    }
  | {
      kind: "apply_patch";
      files: Array<
        | {
            path: unknown;
            content: unknown;
          }
        | {
            path: unknown;
            edits: unknown;
          }
      >;
      cwd: string;
    }
  | {
      kind: "custom_tool_call";
      toolName: string;
      arguments: Record<string, unknown>;
      cwd: string;
    }
  | {
      kind: "mcp_tool_call";
      serverName: string;
      toolName: string;
      connectorId?: string;
      connected_account_email?: string;
      arguments: Record<string, unknown>;
      cwd: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputRecord(event: ToolCallEvent): Record<string, unknown> {
  return isRecord(event.input) ? event.input : {};
}

function metadataRecord(event: ToolCallEvent): Record<string, unknown> | undefined {
  const metadata = (event as ToolCallEvent & { metadata?: unknown }).metadata;
  return isRecord(metadata) ? metadata : undefined;
}

function mcpMetadata(event: ToolCallEvent):
  | {
      serverName: string;
      toolName: string;
      connectorId?: string;
      connected_account_email?: string;
    }
  | undefined {
  const metadata = metadataRecord(event);
  if (!metadata) return undefined;
  const candidate = isRecord(metadata.mcp) ? metadata.mcp : metadata;
  const serverName =
    typeof candidate.serverName === "string"
      ? candidate.serverName
      : typeof candidate.mcpServerName === "string"
        ? candidate.mcpServerName
        : undefined;
  const toolName =
    typeof candidate.toolName === "string"
      ? candidate.toolName
      : typeof candidate.mcpToolName === "string"
        ? candidate.mcpToolName
        : undefined;
  if (!serverName || !toolName) return undefined;
  const connectorId = typeof candidate.connectorId === "string" ? candidate.connectorId : undefined;
  const connectedAccountEmail =
    typeof candidate.connectedAccountEmail === "string"
      ? candidate.connectedAccountEmail
      : typeof candidate.connected_account_email === "string"
        ? candidate.connected_account_email
        : undefined;
  return {
    serverName,
    toolName,
    ...(connectorId === undefined ? {} : { connectorId }),
    ...(connectedAccountEmail === undefined
      ? {}
      : { connected_account_email: connectedAccountEmail }),
  };
}

export function guardianActionFromToolCall(event: ToolCallEvent, cwd: string): GuardianAction {
  const input = inputRecord(event);
  if (event.toolName === "bash") {
    return {
      kind: "shell",
      command: typeof input.command === "string" ? input.command : "",
      cwd,
    };
  }
  if (event.toolName === "write") {
    return {
      kind: "apply_patch",
      files: [{ path: input.path, content: input.content }],
      cwd,
    };
  }
  if (event.toolName === "edit") {
    return {
      kind: "apply_patch",
      files: [{ path: input.path, edits: input.edits }],
      cwd,
    };
  }
  const explicitMcp = mcpMetadata(event);
  if (explicitMcp) {
    return {
      kind: "mcp_tool_call",
      ...explicitMcp,
      arguments: { ...input },
      cwd,
    };
  }
  return {
    kind: "custom_tool_call",
    toolName: event.toolName,
    arguments: { ...input },
    cwd,
  };
}
