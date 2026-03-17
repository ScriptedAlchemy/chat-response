import {
  responseItemId,
  toolCallId
} from "../utils/id.js";
import type {
  ChatAssistantToolCall,
  ChatTool,
  ResponseApplyPatchCall,
  ResponseComputerCall,
  ResponseCustomToolCall,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseShellCall,
  ResponseTool
} from "../types/openai.js";

const PREFIX = "__responses_adapter__";

export interface ToolMapping {
  chatTools: ChatTool[];
  byChatName: Map<string, ToolDefinition>;
}

export interface ToolDefinition {
  chatName: string;
  responseType: string;
  originalName?: string;
  originalTool: ResponseTool;
  directFunction: boolean;
}

function sanitize(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "tool";
}

export function wrappedToolName(responseType: string, originalName?: string): string {
  return `${PREFIX}${sanitize(responseType)}__${sanitize(originalName ?? responseType)}`;
}

function wrapperSchemaFor(tool: ResponseTool): unknown {
  switch (tool.type) {
    case "custom":
      return {
        type: "object",
        properties: {
          input: { type: "string" }
        },
        required: ["input"],
        additionalProperties: true
      };
    case "apply_patch":
      return {
        type: "object",
        properties: {
          type: { type: "string" },
          path: { type: "string" },
          diff: { type: "string" }
        },
        additionalProperties: true
      };
    case "shell":
    case "local_shell":
      return {
        type: "object",
        properties: {
          commands: {
            type: "array",
            items: { type: "string" }
          },
          timeout_ms: { type: "number" },
          max_output_length: { type: "number" }
        },
        additionalProperties: true
      };
    case "computer":
    case "computer_use_preview":
      return {
        type: "object",
        additionalProperties: true
      };
    default:
      return {
        type: "object",
        additionalProperties: true
      };
  }
}

function wrapperDescriptionFor(tool: ResponseTool): string {
  const originalName = tool.name ?? tool.type;
  return `Responses adapter wrapper for ${tool.type} tool "${originalName}".`;
}

export function mapResponseToolsToChatTools(tools: ResponseTool[] | null | undefined): ToolMapping {
  const chatTools: ChatTool[] = [];
  const byChatName = new Map<string, ToolDefinition>();

  for (const tool of tools ?? []) {
    if (tool.type === "function" && tool.name) {
      const definition: ToolDefinition = {
        chatName: tool.name,
        responseType: "function",
        originalName: tool.name,
        originalTool: tool,
        directFunction: true
      };

      chatTools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict ?? true
        }
      });
      byChatName.set(definition.chatName, definition);
      continue;
    }

    const originalName = tool.name ?? tool.type;
    const chatName = wrappedToolName(tool.type, originalName);
    const definition: ToolDefinition = {
      chatName,
      responseType: tool.type,
      originalName,
      originalTool: tool,
      directFunction: false
    };

    chatTools.push({
      type: "function",
      function: {
        name: chatName,
        description: tool.description ?? wrapperDescriptionFor(tool),
        parameters: wrapperSchemaFor(tool),
        strict: false
      }
    });
    byChatName.set(chatName, definition);
  }

  return { chatTools, byChatName };
}

export function mapToolChoice(
  toolChoice: unknown,
  mapping: ToolMapping,
): unknown {
  if (
    toolChoice === null ||
    toolChoice === undefined ||
    typeof toolChoice === "string" ||
    typeof toolChoice === "number" ||
    typeof toolChoice === "boolean"
  ) {
    return toolChoice;
  }

  if (Array.isArray(toolChoice)) {
    return toolChoice;
  }

  const object = { ...toolChoice } as Record<string, unknown>;
  if (object.type === "function") {
    const functionValue = object.function as Record<string, unknown> | undefined;
    const requestedName =
      typeof functionValue?.name === "string"
        ? functionValue.name
        : typeof object.name === "string"
          ? object.name
          : undefined;

    if (requestedName) {
      return {
        type: "function",
        function: {
          name: requestedName
        }
      };
    }
  }

  const requestedCustomName =
    typeof object.name === "string"
      ? object.name
      : typeof (object.custom as Record<string, unknown> | undefined)?.name === "string"
        ? ((object.custom as Record<string, unknown>).name as string)
        : undefined;

  if (requestedCustomName) {
    for (const definition of mapping.byChatName.values()) {
      if (
        definition.originalName === requestedCustomName ||
        definition.chatName === requestedCustomName
      ) {
        return {
          type: "function",
          function: {
            name: definition.chatName
          }
        };
      }
    }
  }

  return toolChoice;
}

function stringifyJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function asObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }

  return { value };
}

export function unwrapChatToolCall(
  toolCall: ChatAssistantToolCall,
  mapping: ToolMapping,
): ResponseOutputItem {
  const definition = mapping.byChatName.get(toolCall.function.name);

  if (!definition || definition.directFunction) {
    const item: ResponseFunctionToolCall = {
      id: responseItemId(),
      type: "function_call",
      call_id: toolCall.id || toolCallId(),
      name: definition?.originalName ?? toolCall.function.name,
      arguments: toolCall.function.arguments,
      status: "completed"
    };
    return item;
  }

  switch (definition.responseType) {
    case "custom": {
      const parsed = asObject(toolCall.function.arguments);
      const item: ResponseCustomToolCall = {
        id: responseItemId(),
        type: "custom_tool_call",
        call_id: toolCall.id || toolCallId(),
        name: definition.originalName ?? "custom",
        input:
          typeof parsed.input === "string"
            ? parsed.input
            : stringifyJson(parsed.input ?? toolCall.function.arguments)
      };
      return item;
    }
    case "apply_patch": {
      const item: ResponseApplyPatchCall = {
        id: responseItemId(),
        type: "apply_patch_call",
        call_id: toolCall.id || toolCallId(),
        status: "completed",
        operation: asObject(toolCall.function.arguments)
      };
      return item;
    }
    case "shell":
    case "local_shell": {
      const item: ResponseShellCall = {
        id: responseItemId(),
        type: "shell_call",
        call_id: toolCall.id || toolCallId(),
        status: "completed",
        action: asObject(toolCall.function.arguments),
        environment:
          definition.responseType === "local_shell" ? { type: "local" } : null
      };
      return item;
    }
    case "computer":
    case "computer_use_preview": {
      const parsed = asObject(toolCall.function.arguments);
      const item: ResponseComputerCall = {
        id: responseItemId(),
        type: "computer_call",
        call_id: toolCall.id || toolCallId(),
        status: "completed",
        pending_safety_checks: [],
        action:
          parsed.action && typeof parsed.action === "object" ? parsed.action : undefined,
        actions: Array.isArray(parsed.actions) ? parsed.actions : undefined
      };
      return item;
    }
    default: {
      const fallback: ResponseFunctionToolCall = {
        id: responseItemId(),
        type: "function_call",
        call_id: toolCall.id || toolCallId(),
        name: definition.originalName ?? definition.responseType,
        arguments: toolCall.function.arguments,
        status: "completed"
      };
      return fallback;
    }
  }
}

export function outputItemToAssistantToolCall(item: ResponseOutputItem): ChatAssistantToolCall | null {
  switch (item.type) {
    case "function_call":
      return {
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments
        }
      };
    case "custom_tool_call":
      return {
        id: item.call_id,
        type: "function",
        function: {
          name: wrappedToolName("custom", item.name),
          arguments: JSON.stringify({ input: item.input })
        }
      };
    case "apply_patch_call":
      return {
        id: item.call_id,
        type: "function",
        function: {
          name: wrappedToolName("apply_patch", "apply_patch"),
          arguments: JSON.stringify(item.operation)
        }
      };
    case "shell_call":
      return {
        id: item.call_id,
        type: "function",
        function: {
          name: wrappedToolName("shell", "shell"),
          arguments: JSON.stringify(item.action)
        }
      };
    case "computer_call":
      return {
        id: item.call_id,
        type: "function",
        function: {
          name: wrappedToolName("computer", "computer"),
          arguments: JSON.stringify({
            action: item.action,
            actions: item.actions
          })
        }
      };
    default:
      return null;
  }
}

export function toolOutputItemToChatToolMessage(item: ResponseInputItem): { tool_call_id: string; content: string } | null {
  switch (item.type) {
    case "function_call_output":
    case "custom_tool_call_output":
    case "apply_patch_call_output":
    case "shell_call_output":
    case "computer_call_output":
      return {
        tool_call_id: item.call_id ?? toolCallId(),
        content: stringifyJson(item.output ?? "")
      };
    default:
      return null;
  }
}
