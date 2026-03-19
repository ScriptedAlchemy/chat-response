import type {
  ChatCompletionRequest,
  ResponseInputItem,
  ResponseObject,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponsesCreateRequest,
  StoredResponse
} from "../types/openai.js";

export interface ResponseStoreLike {
  createResponse(tenantId: string, record: {
    id: string;
    createdAt: number;
    request: ResponsesCreateRequest;
    chatRequest: ChatCompletionRequest | null;
    response: ResponseObject;
    previousResponseId?: string | null;
    conversationId?: string | null;
    background?: boolean;
  }): Promise<void>;
  updateResponse(
    tenantId: string,
    responseId: string,
    response: ResponseObject,
    chatRequest?: ChatCompletionRequest | null,
  ): Promise<void>;
  setResponseStatus(tenantId: string, responseId: string, status: string): Promise<void>;
  markCancelRequested(tenantId: string, responseId: string): Promise<void>;
  isCancelRequested(tenantId: string, responseId: string): Promise<boolean>;
  deleteResponse(tenantId: string, responseId: string): Promise<void>;
  storeItems(
    tenantId: string,
    responseId: string,
    direction: "input" | "output",
    items: Array<ResponseInputItem | ResponseOutputItem>,
  ): Promise<void>;
  clearItems(tenantId: string, responseId: string, direction?: "input" | "output"): Promise<void>;
  appendEvents(tenantId: string, responseId: string, events: ResponseStreamEvent[]): Promise<void>;
  replaceEvents(tenantId: string, responseId: string, events: ResponseStreamEvent[]): Promise<void>;
  getEvents(tenantId: string, responseId: string): Promise<ResponseStreamEvent[]>;
  getResponse(tenantId: string, responseId: string): Promise<StoredResponse | null>;
  getItems<T>(tenantId: string, responseId: string, direction: "input" | "output"): Promise<T[]>;
  listInputItems(
    tenantId: string,
    responseId: string,
    options?: { order?: "asc" | "desc"; limit?: number; after?: string | null },
  ): Promise<ResponseInputItem[]>;
  upsertConversation(tenantId: string, id: string, lastResponseId: string): Promise<void>;
  getConversationResponses(tenantId: string, id: string): Promise<StoredResponse[]>;
  getChainUntil(tenantId: string, responseId: string): Promise<StoredResponse[]>;
  createBackgroundJob(tenantId: string, responseId: string): Promise<void>;
  updateBackgroundJob(
    tenantId: string,
    responseId: string,
    state: string,
    options?: { finished?: boolean; error?: string | null },
  ): Promise<void>;
}
