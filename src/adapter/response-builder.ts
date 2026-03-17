import {
  responseItemId
} from "../utils/id.js";
import type {
  ChatCompletionResponse,
  ResponseInputItem,
  ResponseObject,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseTool,
  ResponsesCreateRequest
} from "../types/openai.js";
import type { ToolMapping } from "./tool-mapper.js";
import { unwrapChatToolCall } from "./tool-mapper.js";

function responseUsageFromChat(chat: ChatCompletionResponse): ResponseObject["usage"] | undefined {
  if (!chat.usage) {
    return undefined;
  }

  return {
    input_tokens: chat.usage.prompt_tokens,
    output_tokens: chat.usage.completion_tokens,
    total_tokens: chat.usage.total_tokens
  };
}

function buildMessageItem(choice: ChatCompletionResponse["choices"][number]): ResponseOutputMessage | null {
  const text = choice.message.content ?? "";
  const refusal = choice.message.refusal ?? null;
  if (!text && !refusal) {
    return null;
  }

  return {
    id: responseItemId(),
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      ...(text
        ? [
            {
              type: "output_text" as const,
              text,
              annotations: []
            }
          ]
        : []),
      ...(refusal
        ? [
            {
              type: "refusal" as const,
              refusal
            }
          ]
        : [])
    ]
  };
}

export function buildResponseShell(params: {
  id: string;
  request: ResponsesCreateRequest;
  createdAt: number;
  conversationId?: string | null;
}): ResponseObject {
  return {
    id: params.id,
    object: "response",
    created_at: params.createdAt,
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: params.request.instructions ?? null,
    metadata: params.request.metadata ?? null,
    model: params.request.model ?? "",
    output: [],
    parallel_tool_calls: params.request.parallel_tool_calls ?? true,
    temperature: params.request.temperature ?? null,
    tool_choice: params.request.tool_choice,
    tools: (params.request.tools ?? []) as ResponseTool[],
    top_p: params.request.top_p ?? null,
    background: params.request.background ?? null,
    conversation: params.conversationId ? { id: params.conversationId } : null,
    max_output_tokens: params.request.max_output_tokens ?? null,
    previous_response_id: params.request.previous_response_id ?? null,
    prompt: params.request.prompt ?? null,
    prompt_cache_key: params.request.prompt_cache_key,
    prompt_cache_retention: params.request.prompt_cache_retention ?? null,
    reasoning: params.request.reasoning ?? null,
    safety_identifier: params.request.safety_identifier,
    service_tier: params.request.service_tier ?? null,
    status: params.request.background ? "queued" : "in_progress",
    text: params.request.text ?? null,
    truncation: params.request.truncation ?? null,
    user: params.request.user
  };
}

export function buildCompletedResponse(params: {
  shell: ResponseObject;
  chat: ChatCompletionResponse;
  request: ResponsesCreateRequest;
  toolMapping: ToolMapping;
}): {
  response: ResponseObject;
  outputItems: ResponseOutputItem[];
} {
  const choice = params.chat.choices[0];
  if (!choice) {
    throw new Error("Upstream chat completion returned no choices.");
  }
  const outputItems: ResponseOutputItem[] = [];

  const messageItem = buildMessageItem(choice);
  if (messageItem) {
    outputItems.push(messageItem);
  }

  for (const toolCall of choice.message.tool_calls ?? []) {
    outputItems.push(unwrapChatToolCall(toolCall, params.toolMapping));
  }

  const outputText = messageItem
    ? messageItem.content
        .map((part) => ("text" in part ? part.text : ""))
        .join("")
    : "";

  const response: ResponseObject = {
    ...params.shell,
    completed_at: Math.floor(Date.now() / 1000),
    output: outputItems,
    output_text: outputText,
    model: params.chat.model || params.shell.model,
    service_tier: params.chat.service_tier ?? params.shell.service_tier ?? null,
    status: "completed",
    usage: responseUsageFromChat(params.chat)
  };

  return { response, outputItems };
}

export function normalizeInputItems(input: ResponsesCreateRequest["input"]): ResponseInputItem[] {
  if (!input) {
    return [];
  }

  if (typeof input === "string") {
    return [
      {
        id: responseItemId(),
        type: "message",
        role: "user",
        content: input
      }
    ];
  }

  return input.map((item, index) => ({
    id: item.id ?? responseItemId(),
    ...item,
    type: item.type ?? "message",
    status: item.status ?? "completed",
    role: item.role ?? "user",
    content: item.content ?? []
  }));
}
