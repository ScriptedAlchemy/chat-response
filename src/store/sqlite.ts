import { DatabaseSync } from "node:sqlite";

import type { ResponseStoreLike } from "./response-store.js";
import type {
  ChatCompletionRequest,
  ResponseInputItem,
  ResponseObject,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponsesCreateRequest,
  StoredResponse
} from "../types/openai.js";

interface ResponseRow {
  id: string;
  request_json: string;
  chat_request_json: string | null;
  response_json: string;
  status: string;
  previous_response_id: string | null;
  conversation_id: string | null;
  deleted: number;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as T;
}

export class ResponseStore implements ResponseStoreLike {
  public readonly db: DatabaseSync;

  public constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id TEXT PRIMARY KEY,
        label TEXT,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        encryption_enabled INTEGER NOT NULL DEFAULT 0,
        upstream_base_url TEXT,
        upstream_chat_path TEXT,
        upstream_api_key TEXT,
        upstream_auth_mode TEXT,
        upstream_api_key_header TEXT,
        upstream_query_params TEXT,
        upstream_headers TEXT,
        upstream_supports_developer_role INTEGER NOT NULL DEFAULT 1,
        upstream_supports_audio_input INTEGER NOT NULL DEFAULT 1,
        upstream_supports_file_parts INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS responses (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        chat_request_json TEXT,
        response_json TEXT NOT NULL,
        previous_response_id TEXT,
        conversation_id TEXT,
        background INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS response_items (
        tenant_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        response_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        item_index INTEGER NOT NULL,
        item_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS response_events (
        tenant_id TEXT NOT NULL,
        response_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, response_id, sequence_number)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        last_response_id TEXT,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS background_jobs (
        tenant_id TEXT NOT NULL,
        response_id TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT,
        PRIMARY KEY (tenant_id, response_id)
      );
    `);
  }

  public async createResponse(
    tenantId: string,
    record: {
      id: string;
      createdAt: number;
      request: ResponsesCreateRequest;
      chatRequest: ChatCompletionRequest | null;
      response: ResponseObject;
      previousResponseId?: string | null;
      conversationId?: string | null;
      background?: boolean;
    },
  ): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO responses (
            tenant_id, id, created_at, completed_at, status, request_json, chat_request_json,
            response_json, previous_response_id, conversation_id, background, cancel_requested, deleted
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
        `,
      )
      .run(
        tenantId,
        record.id,
        record.createdAt,
        record.response.completed_at ?? null,
        record.response.status ?? "in_progress",
        JSON.stringify(record.request),
        record.chatRequest ? JSON.stringify(record.chatRequest) : null,
        JSON.stringify(record.response),
        record.previousResponseId ?? null,
        record.conversationId ?? null,
        record.background ? 1 : 0,
      );
  }

  public async updateResponse(
    tenantId: string,
    responseId: string,
    response: ResponseObject,
    chatRequest?: ChatCompletionRequest | null,
  ): Promise<void> {
    this.db
      .prepare(
        `
          UPDATE responses
          SET response_json = ?, chat_request_json = COALESCE(?, chat_request_json), status = ?, completed_at = ?
          WHERE tenant_id = ? AND id = ?
        `,
      )
      .run(
        JSON.stringify(response),
        chatRequest === undefined ? null : chatRequest ? JSON.stringify(chatRequest) : null,
        response.status ?? "completed",
        response.completed_at ?? null,
        tenantId,
        responseId,
      );
  }

  public async setResponseStatus(tenantId: string, responseId: string, status: string): Promise<void> {
    const row = this.getResponseRow(tenantId, responseId);
    if (!row) {
      return;
    }

    const current = parseJson<ResponseObject>(row.response_json);
    if (!current) {
      return;
    }

    current.status = status as ResponseObject["status"];
    if (status === "completed" || status === "cancelled" || status === "failed") {
      current.completed_at = Math.floor(Date.now() / 1000);
    }

    await this.updateResponse(tenantId, responseId, current);
  }

  public async markCancelRequested(tenantId: string, responseId: string): Promise<void> {
    this.db
      .prepare(`UPDATE responses SET cancel_requested = 1 WHERE tenant_id = ? AND id = ?`)
      .run(tenantId, responseId);
  }

  public async isCancelRequested(tenantId: string, responseId: string): Promise<boolean> {
    const row = this.db
      .prepare(`SELECT cancel_requested FROM responses WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, responseId) as { cancel_requested?: number } | undefined;
    return Boolean(row?.cancel_requested);
  }

  public async deleteResponse(tenantId: string, responseId: string): Promise<void> {
    this.db
      .prepare(`UPDATE responses SET deleted = 1 WHERE tenant_id = ? AND id = ?`)
      .run(tenantId, responseId);
  }

  public async storeItems(
    tenantId: string,
    responseId: string,
    direction: "input" | "output",
    items: Array<ResponseInputItem | ResponseOutputItem>,
  ): Promise<void> {
    const statement = this.db.prepare(
      `
        INSERT OR REPLACE INTO response_items (tenant_id, item_id, response_id, direction, item_index, item_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    );

    for (const [index, item] of items.entries()) {
      const itemId =
        typeof item === "object" && item && "id" in item && typeof item.id === "string"
          ? item.id
          : `${tenantId}_${responseId}_${direction}_${index}`;

      statement.run(tenantId, itemId, responseId, direction, index, JSON.stringify(item));
    }
  }

  public async clearItems(
    tenantId: string,
    responseId: string,
    direction?: "input" | "output",
  ): Promise<void> {
    if (direction) {
      this.db
        .prepare(`DELETE FROM response_items WHERE tenant_id = ? AND response_id = ? AND direction = ?`)
        .run(tenantId, responseId, direction);
      return;
    }

    this.db
      .prepare(`DELETE FROM response_items WHERE tenant_id = ? AND response_id = ?`)
      .run(tenantId, responseId);
  }

  public async appendEvents(tenantId: string, responseId: string, events: ResponseStreamEvent[]): Promise<void> {
    const statement = this.db.prepare(
      `
        INSERT INTO response_events (tenant_id, response_id, sequence_number, event_type, event_json)
        VALUES (?, ?, ?, ?, ?)
      `,
    );

    for (const [index, event] of events.entries()) {
      const sequenceNumber =
        typeof event.sequence_number === "number" ? event.sequence_number : index + 1;
      statement.run(tenantId, responseId, sequenceNumber, event.type, JSON.stringify(event));
    }
  }

  public async replaceEvents(tenantId: string, responseId: string, events: ResponseStreamEvent[]): Promise<void> {
    this.db
      .prepare(`DELETE FROM response_events WHERE tenant_id = ? AND response_id = ?`)
      .run(tenantId, responseId);
    await this.appendEvents(tenantId, responseId, events);
  }

  public async getEvents(tenantId: string, responseId: string): Promise<ResponseStreamEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT event_json FROM response_events WHERE tenant_id = ? AND response_id = ? ORDER BY sequence_number ASC`,
      )
      .all(tenantId, responseId) as Array<{ event_json: string }>;

    return rows.map((row) => JSON.parse(row.event_json) as ResponseStreamEvent);
  }

  public async getResponse(tenantId: string, responseId: string): Promise<StoredResponse | null> {
    const row = this.getResponseRow(tenantId, responseId);
    if (!row || row.deleted) {
      return null;
    }

    const response = parseJson<ResponseObject>(row.response_json);
    const request = parseJson<ResponsesCreateRequest>(row.request_json);
    if (!response || !request) {
      return null;
    }

    return {
      id: responseId,
      request,
      chatRequest: parseJson<ChatCompletionRequest>(row.chat_request_json),
      response,
      inputItems: await this.getItems<ResponseInputItem>(tenantId, responseId, "input"),
      outputItems: await this.getItems<ResponseOutputItem>(tenantId, responseId, "output"),
      eventStream: await this.getEvents(tenantId, responseId)
    };
  }

  public async getItems<T>(tenantId: string, responseId: string, direction: "input" | "output"): Promise<T[]> {
    const rows = this.db
      .prepare(
        `
          SELECT item_json
          FROM response_items
          WHERE tenant_id = ? AND response_id = ? AND direction = ?
          ORDER BY item_index ASC
        `,
      )
      .all(tenantId, responseId, direction) as Array<{ item_json: string }>;

    return rows.map((row) => JSON.parse(row.item_json) as T);
  }

  public async listInputItems(
    tenantId: string,
    responseId: string,
    options?: { order?: "asc" | "desc"; limit?: number; after?: string | null },
  ): Promise<ResponseInputItem[]> {
    let items = await this.getItems<ResponseInputItem>(tenantId, responseId, "input");

    if (options?.after) {
      const index = items.findIndex((item) => item.id === options.after);
      if (index >= 0) {
        items = items.slice(index + 1);
      }
    }

    if (options?.order === "desc") {
      items = [...items].reverse();
    }

    if (options?.limit && options.limit > 0) {
      items = items.slice(0, options.limit);
    }

    return items;
  }

  public async upsertConversation(tenantId: string, id: string, lastResponseId: string): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO conversations (tenant_id, id, last_response_id)
          VALUES (?, ?, ?)
          ON CONFLICT(tenant_id, id) DO UPDATE SET last_response_id = excluded.last_response_id
        `,
      )
      .run(tenantId, id, lastResponseId);
  }

  public async getConversationResponses(tenantId: string, id: string): Promise<StoredResponse[]> {
    const rows = this.db
      .prepare(
        `
          SELECT id
          FROM responses
          WHERE tenant_id = ? AND conversation_id = ? AND deleted = 0
          ORDER BY created_at ASC
        `,
      )
      .all(tenantId, id) as Array<{ id: string }>;

    const responses = await Promise.all(rows.map((row) => this.getResponse(tenantId, row.id)));
    return responses.filter((row): row is StoredResponse => row !== null);
  }

  public async getChainUntil(tenantId: string, responseId: string): Promise<StoredResponse[]> {
    const chain: StoredResponse[] = [];
    let cursor: string | null = responseId;

    while (cursor) {
      const response = await this.getResponse(tenantId, cursor);
      if (!response) {
        break;
      }

      chain.unshift(response);
      cursor = response.response.previous_response_id ?? null;
    }

    return chain;
  }

  public async createBackgroundJob(tenantId: string, responseId: string): Promise<void> {
    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO background_jobs (tenant_id, response_id, state, started_at, finished_at, error)
          VALUES (?, ?, 'queued', ?, NULL, NULL)
        `,
      )
      .run(tenantId, responseId, Date.now());
  }

  public async updateBackgroundJob(
    tenantId: string,
    responseId: string,
    state: string,
    options?: { finished?: boolean; error?: string | null },
  ): Promise<void> {
    this.db
      .prepare(
        `
          UPDATE background_jobs
          SET state = ?, finished_at = ?, error = COALESCE(?, error)
          WHERE tenant_id = ? AND response_id = ?
        `,
      )
      .run(state, options?.finished ? Date.now() : null, options?.error ?? null, tenantId, responseId);
  }

  private getResponseRow(tenantId: string, responseId: string): ResponseRow | null {
    const row = this.db
      .prepare(
        `
          SELECT id, request_json, chat_request_json, response_json, status, previous_response_id, conversation_id, deleted
          FROM responses
          WHERE tenant_id = ? AND id = ?
        `,
      )
      .get(tenantId, responseId) as ResponseRow | undefined;

    return row ?? null;
  }
}
