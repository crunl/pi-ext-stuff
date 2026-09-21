import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./unknown-value.ts";

export type GuardianAction =
  | {
      kind: "shell";
      toolCallId: string;
      command: string;
      cwd: string;
    }
  | {
      kind: "apply_patch";
      toolCallId: string;
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
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      cwd: string;
    }
  | {
      kind: "mcp_tool_call";
      toolCallId: string;
      serverName: string;
      toolName: string;
      connectorId?: string;
      connected_account_email?: string;
      arguments: Record<string, unknown>;
      cwd: string;
    };

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
      toolCallId: event.toolCallId,
      command: typeof input.command === "string" ? input.command : "",
      cwd,
    };
  }
  if (event.toolName === "write") {
    return {
      kind: "apply_patch",
      toolCallId: event.toolCallId,
      files: [{ path: input.path, content: input.content }],
      cwd,
    };
  }
  if (event.toolName === "edit") {
    return {
      kind: "apply_patch",
      toolCallId: event.toolCallId,
      files: [{ path: input.path, edits: input.edits }],
      cwd,
    };
  }
  const explicitMcp = mcpMetadata(event);
  if (explicitMcp) {
    return {
      kind: "mcp_tool_call",
      toolCallId: event.toolCallId,
      ...explicitMcp,
      arguments: { ...input },
      cwd,
    };
  }
  return {
    kind: "custom_tool_call",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    arguments: { ...input },
    cwd,
  };
}
