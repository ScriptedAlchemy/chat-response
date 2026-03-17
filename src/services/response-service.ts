import { invalidRequest, notFound } from "../errors.js";
import type { AdapterConfig } from "../config.js";
import type {
  ChatCompletionRequest,
  CompactedResponse,
  InputItemListResponse,
  InputTokenCountRequest,
  ResponseInputItem,
  ResponseObject,
  ResponseStreamEvent,
  ResponsesCreateRequest,
  StoredResponse
} from "../types/openai.js";
import { compactionId, conversationId, responseId } from "../utils/id.js";
import { encodeDoneFrame, encodeSseFrame } from "../utils/sse.js";
import { inputItemToChatMessages, outputItemToChatMessages } from "../adapter/input-to-messages.js";
import {
  buildCompletedResponse,
  buildResponseShell,
  normalizeInputItems
} from "../adapter/response-builder.js";
import { transcodeChatStream } from "../adapter/stream-transcoder.js";
import {
  mapResponseToolsToChatTools,
  mapToolChoice
} from "../adapter/tool-mapper.js";
import { ResponseStore } from "../store/sqlite.js";
import { ChatCompletionsClient } from "../upstream/chat-client.js";

export class ResponseService {
  private readonly jobs = new Map<string, AbortController>();

  public constructor(
    private readonly config: AdapterConfig,
    private readonly store: ResponseStore,
    private readonly client: ChatCompletionsClient,
  ) {}

  public async create(
    request: ResponsesCreateRequest,
  ): Promise<StoredResponse> {
    const { requestId, conversation, inputItems, chatRequest, toolMapping, shell } =
      this.prepareRequest(request);

    this.store.createResponse({
      id: requestId,
      createdAt: shell.created_at,
      request,
      chatRequest,
      response: shell,
      previousResponseId: request.previous_response_id ?? null,
      conversationId: conversation,
      background: Boolean(request.background)
    });
    this.store.storeItems(requestId, "input", inputItems);

    if (request.background) {
      if (request.stream) {
        throw invalidRequest("background and stream cannot be used together", "stream");
      }

      this.store.createBackgroundJob(requestId);
      this.runBackground(requestId, request, conversation, inputItems, chatRequest, toolMapping, shell);
      return this.mustGetResponse(requestId);
    }

    const chat = await this.client.create(chatRequest);
    const completed = buildCompletedResponse({
      shell,
      chat,
      request,
      toolMapping
    });

    this.store.clearItems(requestId, "output");
    this.store.storeItems(requestId, "output", completed.outputItems);
    this.store.updateResponse(requestId, completed.response, chatRequest);
    if (conversation) {
      this.store.upsertConversation(conversation, requestId);
    }

    return this.mustGetResponse(requestId);
  }

  public async createStream(
    request: ResponsesCreateRequest,
    write: (chunk: string) => Promise<void> | void,
  ): Promise<StoredResponse> {
    const { requestId, conversation, inputItems, chatRequest, toolMapping, shell } =
      this.prepareRequest(request);

    this.store.createResponse({
      id: requestId,
      createdAt: shell.created_at,
      request,
      chatRequest,
      response: shell,
      previousResponseId: request.previous_response_id ?? null,
      conversationId: conversation,
      background: false
    });
    this.store.storeItems(requestId, "input", inputItems);

    const upstream = await this.client.createStream(chatRequest);
    const transcoded = await transcodeChatStream({
      stream: upstream,
      shell,
      request,
      toolMapping,
      emit: async (event) => {
        await write(encodeSseFrame(event.type, event));
      }
    });

    await write(encodeDoneFrame());

    this.store.clearItems(requestId, "output");
    this.store.storeItems(requestId, "output", transcoded.outputItems);
    this.store.replaceEvents(requestId, transcoded.events);
    this.store.updateResponse(requestId, transcoded.response, chatRequest);
    if (conversation) {
      this.store.upsertConversation(conversation, requestId);
    }

    return this.mustGetResponse(requestId);
  }

  public getResponse(id: string): StoredResponse {
    return this.mustGetResponse(id);
  }

  public listInputItems(
    responseId: string,
    options?: { order?: "asc" | "desc"; limit?: number; after?: string | null },
  ): InputItemListResponse {
    this.mustGetResponse(responseId);
    const items = this.store.listInputItems(responseId, options);

    return {
      object: "list",
      data: items,
      first_id: items[0]?.id ?? null,
      last_id: items.at(-1)?.id ?? null,
      has_more: false
    };
  }

  public deleteResponse(id: string): void {
    this.mustGetResponse(id);
    this.store.deleteResponse(id);
  }

  public cancelResponse(id: string): ResponseObject {
    const stored = this.mustGetResponse(id);
    if (
      stored.response.status === "completed" ||
      stored.response.status === "failed" ||
      stored.response.status === "cancelled"
    ) {
      return stored.response;
    }

    this.store.markCancelRequested(id);
    const controller = this.jobs.get(id);
    if (controller) {
      controller.abort();
    }

    const cancelled: ResponseObject = {
      ...stored.response,
      status: "cancelled",
      completed_at: Math.floor(Date.now() / 1000)
    };
    this.store.updateResponse(id, cancelled);
    this.store.updateBackgroundJob(id, "cancelled", { finished: true });

    return cancelled;
  }

  public async replayResponseStream(
    id: string,
    write: (chunk: string) => Promise<void> | void,
  ): Promise<void> {
    const stored = this.mustGetResponse(id);
    const events = stored.eventStream.length ? stored.eventStream : this.synthesizeReplayEvents(stored.response);
    for (const event of events) {
      await write(encodeSseFrame(event.type, event));
    }
    await write(encodeDoneFrame());
  }

  public async countInputTokens(body: InputTokenCountRequest): Promise<{ object: "response.input_tokens"; input_tokens: number }> {
    const request: ResponsesCreateRequest = {
      model: body.model ?? "unknown-model",
      input: body.input ?? null,
      instructions: body.instructions ?? null,
      conversation: body.conversation ?? null,
      previous_response_id: body.previous_response_id ?? null,
      parallel_tool_calls: body.parallel_tool_calls ?? null,
      reasoning: body.reasoning ?? null,
      text: body.text ?? null,
      tool_choice: body.tool_choice,
      tools: body.tools ?? null,
      truncation: body.truncation
    };

    const { chatRequest } = this.prepareRequest(request, false);
    return {
      object: "response.input_tokens",
      input_tokens: Math.max(1, Math.ceil(JSON.stringify(chatRequest).length / 4))
    };
  }

  public async compact(request: ResponsesCreateRequest): Promise<CompactedResponse> {
    const history = this.resolveHistory(request);
    const transcript = history
      .flatMap((entry) => [
        ...entry.inputItems.map((item) => JSON.stringify(item)),
        ...entry.outputItems.map((item) => JSON.stringify(item))
      ])
      .join("\n");

    const compactionRequest: ChatCompletionRequest = {
      model: request.model ?? "unknown-model",
      messages: [
        {
          role: this.config.upstream.supportsDeveloperRole ? "developer" : "system",
          content:
            "Summarize the conversation into a compact state representation that preserves key user goals, constraints, and unresolved tool context."
        },
        {
          role: "user",
          content: transcript || JSON.stringify(request.input ?? "")
        }
      ],
      max_completion_tokens: request.max_output_tokens ?? 512,
      temperature: 0
    };

    const response = await this.client.create(compactionRequest);
    const summary = response.choices[0]?.message.content ?? "";

    return {
      id: compactionId(),
      created_at: Math.floor(Date.now() / 1000),
      object: "response.compaction",
      output: [
        {
          type: "compaction",
          text: summary
        }
      ],
      usage: {
        input_tokens: response.usage?.prompt_tokens,
        output_tokens: response.usage?.completion_tokens,
        total_tokens: response.usage?.total_tokens
      }
    };
  }

  private prepareRequest(
    request: ResponsesCreateRequest,
    persistConversation = true,
  ): {
    requestId: string;
    conversation: string | null;
    inputItems: ResponseInputItem[];
    chatRequest: ChatCompletionRequest;
    toolMapping: ReturnType<typeof mapResponseToolsToChatTools>;
    shell: ResponseObject;
  } {
    if (!request.model) {
      throw invalidRequest("model is required", "model");
    }

    if (request.prompt) {
      throw invalidRequest("prompt templates are not supported by this adapter yet", "prompt");
    }

    const requestId = responseId();
    const history = this.resolveHistory(request);
    const conversation = persistConversation ? this.resolveConversationId(request, history) : null;
    const inputItems = normalizeInputItems(request.input);
    const toolMapping = mapResponseToolsToChatTools(request.tools ?? []);
    const historyMessages = history.flatMap((entry) => [
      ...entry.inputItems.flatMap((item) =>
        inputItemToChatMessages(item, {
          supportsDeveloperRole: this.config.upstream.supportsDeveloperRole,
          supportsAudioInput: this.config.upstream.supportsAudioInput,
          supportsFileParts: this.config.upstream.supportsFileParts
        }),
      ),
      ...entry.outputItems.flatMap((item) => outputItemToChatMessages(item))
    ]);

    const instructionsMessage = request.instructions
      ? [
          {
            role: this.config.upstream.supportsDeveloperRole ? "developer" : "system",
            content: request.instructions
          } as const
        ]
      : [];

    const currentMessages = inputItems.flatMap((item) =>
      inputItemToChatMessages(item, {
        supportsDeveloperRole: this.config.upstream.supportsDeveloperRole,
        supportsAudioInput: this.config.upstream.supportsAudioInput,
        supportsFileParts: this.config.upstream.supportsFileParts
      }),
    );

    const chatRequest: ChatCompletionRequest = {
      model: request.model,
      messages: [...instructionsMessage, ...historyMessages, ...currentMessages],
      metadata: request.metadata ?? null,
      parallel_tool_calls: request.parallel_tool_calls ?? undefined,
      max_completion_tokens: request.max_output_tokens ?? null,
      reasoning_effort: request.reasoning?.effort ?? undefined,
      response_format: request.text?.format,
      prompt_cache_key: request.prompt_cache_key,
      prompt_cache_retention: request.prompt_cache_retention ?? null,
      safety_identifier: request.safety_identifier,
      service_tier: request.service_tier ?? undefined,
      store: request.store ?? null,
      stream: request.stream ?? false,
      stream_options: request.stream ? (request.stream_options ?? undefined) : undefined,
      temperature: request.temperature ?? null,
      tool_choice: mapToolChoice(request.tool_choice, toolMapping),
      tools: toolMapping.chatTools.length ? toolMapping.chatTools : undefined,
      top_p: request.top_p ?? null,
      verbosity: request.text?.verbosity ?? null
    };

    const shell = buildResponseShell({
      id: requestId,
      request,
      createdAt: Math.floor(Date.now() / 1000),
      conversationId: conversation
    });

    return { requestId, conversation, inputItems, chatRequest, toolMapping, shell };
  }

  private resolveHistory(request: ResponsesCreateRequest): StoredResponse[] {
    if (typeof request.conversation === "string") {
      return this.store.getConversationResponses(request.conversation);
    }

    if (request.conversation && typeof request.conversation === "object" && request.conversation.id) {
      return this.store.getConversationResponses(request.conversation.id);
    }

    if (request.previous_response_id) {
      return this.store.getChainUntil(request.previous_response_id);
    }

    return [];
  }

  private resolveConversationId(request: ResponsesCreateRequest, history: StoredResponse[]): string | null {
    if (typeof request.conversation === "string") {
      return request.conversation;
    }

    if (request.conversation && typeof request.conversation === "object") {
      return request.conversation.id ?? conversationId();
    }

    if (history.at(-1)?.response.conversation?.id) {
      return history.at(-1)?.response.conversation?.id ?? null;
    }

    return request.previous_response_id ? conversationId() : null;
  }

  private mustGetResponse(id: string): StoredResponse {
    const stored = this.store.getResponse(id);
    if (!stored) {
      throw notFound(`No response found with id '${id}'.`);
    }
    return stored;
  }

  private runBackground(
    requestId: string,
    request: ResponsesCreateRequest,
    conversation: string | null,
    _inputItems: ResponseInputItem[],
    chatRequest: ChatCompletionRequest,
    toolMapping: ReturnType<typeof mapResponseToolsToChatTools>,
    shell: ResponseObject,
  ): void {
    const controller = new AbortController();
    this.jobs.set(requestId, controller);
    this.store.updateBackgroundJob(requestId, "in_progress");

    void (async () => {
      try {
        const chat = await this.client.create(chatRequest, controller.signal);
        if (this.store.isCancelRequested(requestId)) {
          return;
        }

        const completed = buildCompletedResponse({
          shell: {
            ...shell,
            status: "in_progress"
          },
          chat,
          request,
          toolMapping
        });
        this.store.clearItems(requestId, "output");
        this.store.storeItems(requestId, "output", completed.outputItems);
        this.store.updateResponse(requestId, completed.response, chatRequest);
        this.store.updateBackgroundJob(requestId, "completed", { finished: true });
        if (conversation) {
          this.store.upsertConversation(conversation, requestId);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          this.store.setResponseStatus(requestId, "cancelled");
          this.store.updateBackgroundJob(requestId, "cancelled", { finished: true });
          return;
        }

        const current = this.mustGetResponse(requestId).response;
        this.store.updateResponse(requestId, {
          ...current,
          status: "failed",
          completed_at: Math.floor(Date.now() / 1000),
          error: {
            code: "upstream_error",
            message: error instanceof Error ? error.message : "Background request failed"
          }
        });
        this.store.updateBackgroundJob(requestId, "failed", {
          finished: true,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.jobs.delete(requestId);
      }
    })();
  }

  private synthesizeReplayEvents(response: ResponseObject): ResponseStreamEvent[] {
    const events: ResponseStreamEvent[] = [
      {
        type: "response.created",
        response
      }
    ];

    for (const [index, item] of response.output.entries()) {
      events.push({
        type: "response.output_item.added",
        output_index: index,
        item
      });
      if (item.type === "message") {
        const text = item.content.map((part) => ("text" in part ? part.text : "")).join("");
        if (text) {
          events.push({
            type: "response.output_text.done",
            output_index: index,
            item_id: item.id,
            content_index: 0,
            text,
            logprobs: []
          });
        }
      }
      events.push({
        type: "response.output_item.done",
        output_index: index,
        item
      });
    }

    events.push({
      type: "response.completed",
      response
    });

    return events;
  }
}
