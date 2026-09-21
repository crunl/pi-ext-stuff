import { describe, expect, it } from "vitest";
import { guardianActionFromToolCall } from "../src/guardian-action.ts";

describe("guardian action normalization", () => {
  it("maps bash to a shell action", () => {
    expect(
      guardianActionFromToolCall(
        {
          type: "tool_call",
          toolName: "bash",
          toolCallId: "call-1",
          input: { command: "npm test" },
        },
        "/workspace",
      ),
    ).toEqual({
      kind: "shell",
      toolCallId: "call-1",
      command: "npm test",
      cwd: "/workspace",
    });
  });

  it("maps write to an apply_patch action with file content", () => {
    expect(
      guardianActionFromToolCall(
        {
          type: "tool_call",
          toolName: "write",
          toolCallId: "call-2",
          input: { path: "src/new.ts", content: "export {};\n" },
        },
        "/workspace",
      ),
    ).toEqual({
      kind: "apply_patch",
      toolCallId: "call-2",
      cwd: "/workspace",
      files: [{ path: "src/new.ts", content: "export {};\n" }],
    });
  });

  it("maps edit to an apply_patch action with edits", () => {
    const edits = [{ oldText: "before", newText: "after" }];

    expect(
      guardianActionFromToolCall(
        {
          type: "tool_call",
          toolName: "edit",
          toolCallId: "call-3",
          input: { path: "src/existing.ts", edits },
        },
        "/workspace",
      ),
    ).toEqual({
      kind: "apply_patch",
      toolCallId: "call-3",
      cwd: "/workspace",
      files: [{ path: "src/existing.ts", edits }],
    });
  });

  it("keeps custom tools without explicit metadata as custom tool calls", () => {
    expect(
      guardianActionFromToolCall(
        {
          type: "tool_call",
          toolName: "notion.create_page",
          toolCallId: "call-4",
          input: {
            connectorId: "notion",
            serverName: "notion-server",
            toolName: "create_page",
            title: "Roadmap",
          },
        } as any,
        "/workspace",
      ),
    ).toEqual({
      kind: "custom_tool_call",
      toolCallId: "call-4",
      toolName: "notion.create_page",
      arguments: {
        connectorId: "notion",
        serverName: "notion-server",
        toolName: "create_page",
        title: "Roadmap",
      },
      cwd: "/workspace",
    });
  });

  it("uses complete MCP metadata only when metadata explicitly supplies it", () => {
    expect(
      guardianActionFromToolCall(
        {
          type: "tool_call",
          toolName: "mcp.invoke",
          toolCallId: "call-5",
          input: { title: "Roadmap" },
          metadata: {
            mcp: {
              serverName: "notion-server",
              toolName: "create_page",
              connectorId: "notion",
            },
          },
        } as any,
        "/workspace",
      ),
    ).toEqual({
      kind: "mcp_tool_call",
      toolCallId: "call-5",
      serverName: "notion-server",
      toolName: "create_page",
      connectorId: "notion",
      arguments: { title: "Roadmap" },
      cwd: "/workspace",
    });
  });
});
