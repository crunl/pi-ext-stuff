import type {
  ConstrainedSamplingConfig,
  ImageContent,
  TextContent,
  ToolCall,
  Tool as LlmTool,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const GUARDIAN_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const SENSITIVE_ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/\b(authorization|x-api-key|api-key)\s*[:=]\s*[^,\s]+/gi, "$1: [redacted]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\bbasic\s+[A-Za-z0-9._~+/=-]+/gi, "Basic [redacted]"],
];

export type GuardianToolFactory = (cwd: string) => AgentTool[];

export interface GuardianToolRuntime {
  readonly tools: LlmTool[];
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResultMessage>;
}

interface AgentToolResult {
  content: (TextContent | ImageContent)[];
  details?: unknown;
  usage?: Usage;
  isError?: boolean;
}

interface AgentTool {
  name: string;
  description: string;
  parameters: TSchema;
  constrainedSampling?: false | ConstrainedSamplingConfig;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
  ): Promise<AgentToolResult>;
}

function projectTool(tool: AgentTool): LlmTool {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: tool.constrainedSampling }),
  });
}

function sanitizeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [pattern, replacement] of SENSITIVE_ERROR_PATTERNS) {
    message = message.replace(pattern, replacement);
  }
  return message.slice(0, 2_000);
}

function toolErrorResult(toolCall: ToolCall, error: unknown): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [
      {
        type: "text",
        text: `Guardian tool failed: ${sanitizeErrorMessage(error)}`,
      },
    ],
    isError: true,
    timestamp: Date.now(),
  };
}

export function createGuardianToolRuntime(
  cwd: string,
  toolFactory: GuardianToolFactory = createReadOnlyTools as unknown as GuardianToolFactory,
): GuardianToolRuntime {
  const runtimeTools = toolFactory(cwd).filter((tool) => GUARDIAN_TOOL_NAMES.has(tool.name));
  const toolsByName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
  const exposedTools = runtimeTools.map(projectTool);
  Object.freeze(exposedTools);

  return Object.freeze({
    tools: exposedTools,
    async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResultMessage> {
      const tool = toolsByName.get(toolCall.name);
      if (!tool) {
        throw new Error(`Guardian tool ${toolCall.name} is not available`);
      }

      try {
        const result = await tool.execute(toolCall.id, toolCall.arguments, signal, undefined);
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: result.content,
          ...(result.details === undefined ? {} : { details: result.details }),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          isError: result.isError === true,
          timestamp: Date.now(),
        };
      } catch (error) {
        return toolErrorResult(toolCall, error);
      }
    },
  });
}
