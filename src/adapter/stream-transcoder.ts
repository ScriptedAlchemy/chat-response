import type {
  ChatAssistantToolCall,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ResponseObject,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponsesCreateRequest
} from "../types/openai.js";
import { responseItemId, toolCallId } from "../utils/id.js";
import { readSseStream } from "../utils/sse.js";
import { buildCompletedResponse } from "./response-builder.js";
import type { ToolMapping } from "./tool-mapper.js";

interface StreamAccumulator {
  id: string;
  name: string;
  arguments: string;
  outputIndex: number;
  itemId: string;
}

function chatResponseFromAccumulation(params: {
  id: string;
  model: string;
  created: number;
  text: string;
  refusal: string | null;
  toolCalls: StreamAccumulator[];
  usage?: ChatCompletionResponse["usage"];
}): ChatCompletionResponse {
  const toolCalls: ChatAssistantToolCall[] = params.toolCalls.map((toolCall) => ({
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments
    }
  }));

  return {
    id: params.id,
    object: "chat.completion",
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: params.text || null,
          refusal: params.refusal,
          tool_calls: toolCalls.length ? toolCalls : undefined
        }
      }
    ],
    usage: params.usage
  };
}

export async function transcodeChatStream(options: {
  stream: ReadableStream<Uint8Array>;
  shell: ResponseObject;
  request: ResponsesCreateRequest;
  toolMapping: ToolMapping;
  emit: (event: ResponseStreamEvent) => Promise<void> | void;
}): Promise<{
  response: ResponseObject;
  outputItems: ResponseOutputItem[];
  events: ResponseStreamEvent[];
}> {
  const events: ResponseStreamEvent[] = [];
  let sequence = 1;
  const shell = {
    ...options.shell,
    status: "in_progress" as const
  };

  const push = async (event: ResponseStreamEvent): Promise<void> => {
    const enriched = {
      ...event,
      sequence_number: event.sequence_number ?? sequence++
    };
    events.push(enriched);
    await options.emit(enriched);
  };

  await push({
    type: "response.created",
    response: shell
  });
  await push({
    type: "response.in_progress",
    response: shell
  });

  let text = "";
  let refusal: string | null = null;
  let messageItemId: string | null = null;
  let messageOutputIndex = 0;
  let usage: ChatCompletionResponse["usage"] | undefined;
  let chatId = "";
  let created = Math.floor(Date.now() / 1000);
  let model = options.request.model ?? shell.model;
  const toolCalls = new Map<number, StreamAccumulator>();
  const toolOrder: StreamAccumulator[] = [];

  await readSseStream(options.stream, async (_event, data) => {
    if (data === "[DONE]") {
      return;
    }

    const chunk = JSON.parse(data) as ChatCompletionChunk;
    chatId = chunk.id || chatId;
    created = chunk.created || created;
    model = chunk.model || model;
    if (chunk.usage) {
      usage = chunk.usage;
    }

    for (const choice of chunk.choices) {
      if (choice.delta.content) {
        if (!messageItemId) {
          messageItemId = responseItemId();
          await push({
            type: "response.output_item.added",
            output_index: messageOutputIndex,
            item: {
              id: messageItemId,
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: []
            }
          });
          await push({
            type: "response.content_part.added",
            item_id: messageItemId,
            output_index: messageOutputIndex,
            content_index: 0,
            part: {
              type: "output_text",
              text: "",
              annotations: []
            }
          });
        }

        text += choice.delta.content;
        await push({
          type: "response.output_text.delta",
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          delta: choice.delta.content,
          logprobs: []
        });
      }

      if (choice.delta.refusal) {
        if (!messageItemId) {
          messageItemId = responseItemId();
          await push({
            type: "response.output_item.added",
            output_index: messageOutputIndex,
            item: {
              id: messageItemId,
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: []
            }
          });
        }

        refusal = `${refusal ?? ""}${choice.delta.refusal}`;
        await push({
          type: "response.refusal.delta",
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          delta: choice.delta.refusal
        });
      }

      for (const toolCallDelta of choice.delta.tool_calls ?? []) {
        const existing =
          toolCalls.get(toolCallDelta.index) ??
          ({
            id: toolCallDelta.id ?? toolCallId(),
            name: "",
            arguments: "",
            outputIndex: toolCalls.size + (messageItemId ? 1 : 0),
            itemId: responseItemId()
          } satisfies StreamAccumulator);

        if (!toolCalls.has(toolCallDelta.index)) {
          toolCalls.set(toolCallDelta.index, existing);
          toolOrder.push(existing);
        }

        if (toolCallDelta.id) {
          existing.id = toolCallDelta.id;
        }
        if (toolCallDelta.function?.name) {
          existing.name = `${existing.name}${toolCallDelta.function.name}`;
        }
        if (toolCallDelta.function?.arguments) {
          existing.arguments = `${existing.arguments}${toolCallDelta.function.arguments}`;
        }

        if (existing.arguments === (toolCallDelta.function?.arguments ?? "")) {
          const definition = options.toolMapping.byChatName.get(existing.name);
          const itemType = definition?.directFunction
            ? "function_call"
            : definition?.responseType === "custom"
              ? "custom_tool_call"
              : definition?.responseType === "apply_patch"
                ? "apply_patch_call"
                : definition?.responseType === "shell" || definition?.responseType === "local_shell"
                  ? "shell_call"
                  : definition?.responseType === "computer" ||
                      definition?.responseType === "computer_use_preview"
                    ? "computer_call"
                    : "function_call";

          await push({
            type: "response.output_item.added",
            output_index: existing.outputIndex,
            item:
              itemType === "function_call"
                ? {
                    id: existing.itemId,
                    type: "function_call",
                    call_id: existing.id,
                    name: definition?.originalName ?? existing.name,
                    arguments: "",
                    status: "in_progress"
                  }
                : itemType === "custom_tool_call"
                  ? {
                      id: existing.itemId,
                      type: "custom_tool_call",
                      call_id: existing.id,
                      name: definition?.originalName ?? "custom",
                      input: ""
                    }
                  : itemType === "apply_patch_call"
                    ? {
                        id: existing.itemId,
                        type: "apply_patch_call",
                        call_id: existing.id,
                        status: "in_progress",
                        operation: {}
                      }
                    : itemType === "shell_call"
                      ? {
                          id: existing.itemId,
                          type: "shell_call",
                          call_id: existing.id,
                          status: "in_progress",
                          action: {},
                          environment: null
                        }
                      : {
                          id: existing.itemId,
                          type: "computer_call",
                          call_id: existing.id,
                          status: "in_progress",
                          pending_safety_checks: []
                        }
          });
        }

        const definition = options.toolMapping.byChatName.get(existing.name);
        if ((definition?.directFunction ?? true) && toolCallDelta.function?.arguments) {
          await push({
            type: "response.function_call_arguments.delta",
            item_id: existing.itemId,
            output_index: existing.outputIndex,
            delta: toolCallDelta.function.arguments
          });
        }
      }
    }
  });

  const chatResponse = chatResponseFromAccumulation({
    id: chatId || shell.id,
    model,
    created,
    text,
    refusal,
    toolCalls: toolOrder,
    usage
  });
  const { response, outputItems } = buildCompletedResponse({
    shell,
    chat: chatResponse,
    request: options.request,
    toolMapping: options.toolMapping
  });
  const normalizedOutputItems = outputItems.map((item) => {
    if (item.type === "message" && messageItemId) {
      return {
        ...item,
        id: messageItemId
      };
    }

    if ("call_id" in item) {
      const streamAccumulator = toolOrder.find((toolCall) => toolCall.id === item.call_id);
      if (streamAccumulator) {
        return {
          ...item,
          id: streamAccumulator.itemId
        };
      }
    }

    return item;
  });
  const normalizedResponse: ResponseObject = {
    ...response,
    output: normalizedOutputItems
  };

  if (messageItemId) {
    if (text) {
      await push({
        type: "response.output_text.done",
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        text,
        logprobs: []
      });
    }

    if (refusal) {
      await push({
        type: "response.refusal.done",
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        refusal
      });
    }
  }

  for (const item of normalizedOutputItems) {
    const streamAccumulator =
      "call_id" in item
        ? toolOrder.find((toolCall) => toolCall.id === item.call_id)
        : undefined;
    if (item.type === "function_call" && streamAccumulator) {
      await push({
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: streamAccumulator.outputIndex,
        arguments: item.arguments
      });
    }

    await push({
      type: "response.output_item.done",
      output_index:
        item.type === "message"
          ? messageOutputIndex
          : toolOrder.find((toolCall) => toolCall.id === (item as { call_id?: string }).call_id)
              ?.outputIndex ?? 0,
      item
    });
  }

  await push({
    type: "response.completed",
    response: normalizedResponse
  });

  return { response: normalizedResponse, outputItems: normalizedOutputItems, events };
}
