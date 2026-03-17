import { featureUnsupported } from "../errors.js";
import type {
  ChatContentPart,
  ChatMessage,
  ResponseInputItem,
  ResponseInputMessagePart,
  ResponseOutputItem
} from "../types/openai.js";
import {
  outputItemToAssistantToolCall,
  toolOutputItemToChatToolMessage
} from "./tool-mapper.js";

export interface MessageBuildCapabilities {
  supportsDeveloperRole: boolean;
  supportsAudioInput: boolean;
  supportsFileParts: boolean;
}

function partToChatPart(
  part: ResponseInputMessagePart,
  capabilities: MessageBuildCapabilities,
): ChatContentPart {
  switch (part.type) {
    case "input_text":
    case "text":
    case undefined:
      return {
        type: "text",
        text: part.text ?? part.input_text ?? ""
      };
    case "input_image":
      return {
        type: "image_url",
        image_url: {
          url: part.image_url ?? "",
          detail: typeof part.detail === "string" ? part.detail : undefined
        }
      };
    case "input_file":
      if (!capabilities.supportsFileParts) {
        throw featureUnsupported("This upstream provider is configured without file part support.");
      }
      return {
        type: "file",
        file: {
          file_data: part.file_data ?? undefined,
          file_id: part.file_id ?? undefined,
          filename: part.filename ?? undefined
        }
      };
    case "input_audio":
      if (!capabilities.supportsAudioInput || !part.input_audio) {
        throw featureUnsupported("This upstream provider is configured without audio input support.");
      }
      return {
        type: "input_audio",
        input_audio: part.input_audio
      };
    default:
      return {
        type: "text",
        text: JSON.stringify(part)
      };
  }
}

function contentToChatContent(
  content: ResponseInputItem["content"],
  capabilities: MessageBuildCapabilities,
): string | ChatContentPart[] | null {
  if (content === undefined || content === null) {
    return null;
  }

  if (typeof content === "string") {
    return content;
  }

  return content.map((part) => partToChatPart(part, capabilities));
}

export function inputItemToChatMessages(
  item: ResponseInputItem,
  capabilities: MessageBuildCapabilities,
): ChatMessage[] {
  const toolMessage = toolOutputItemToChatToolMessage(item);
  if (toolMessage) {
    return [
      {
        role: "tool",
        tool_call_id: toolMessage.tool_call_id,
        content: toolMessage.content
      }
    ];
  }

  if (
    item.type === "function_call" ||
    item.type === "custom_tool_call" ||
    item.type === "apply_patch_call" ||
    item.type === "shell_call" ||
    item.type === "computer_call"
  ) {
    const assistantToolCall = outputItemToAssistantToolCall(item as unknown as ResponseOutputItem);
    if (!assistantToolCall) {
      return [];
    }

    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [assistantToolCall]
      }
    ];
  }

  if (item.type === "input_text") {
    return [
      {
        role: "user",
        content: item.text ?? ""
      }
    ];
  }

  if (item.type === "input_image") {
    return [
      {
        role: "user",
        content: [
          partToChatPart(
            {
              type: "input_image",
              image_url: typeof item.image_url === "string" ? item.image_url : "",
              detail: typeof item.detail === "string" ? item.detail : "auto"
            },
            capabilities,
          )
        ]
      }
    ];
  }

  if (item.type === "input_file") {
    return [
      {
        role: "user",
        content: [
          partToChatPart(
            {
              type: "input_file",
              file_data: typeof item.file_data === "string" ? item.file_data : null,
              file_id: typeof item.file_id === "string" ? item.file_id : null,
              filename: typeof item.filename === "string" ? item.filename : null
            },
            capabilities,
          )
        ]
      }
    ];
  }

  const role = item.role ?? "user";
  const normalizedRole =
    role === "developer" && !capabilities.supportsDeveloperRole ? "system" : role;

  return [
    {
      role: normalizedRole,
      content: contentToChatContent(item.content, capabilities)
    }
  ];
}

export function outputItemToChatMessages(item: ResponseOutputItem): ChatMessage[] {
  if (item.type === "message") {
    const text = item.content
      .map((part) => ("text" in part ? part.text : "refusal" in part ? part.refusal : ""))
      .join("");

    return [
      {
        role: "assistant",
        content: text,
        refusal: item.content.find((part) => part.type === "refusal")?.refusal ?? null
      }
    ];
  }

  const assistantToolCall = outputItemToAssistantToolCall(item);
  if (!assistantToolCall) {
    return [];
  }

  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [assistantToolCall]
    }
  ];
}
