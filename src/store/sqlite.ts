import { DatabaseSync } from "node:sqlite";

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

export class ResponseStore {
  public readonly db: DatabaseSync;

  public constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
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
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS response_items (
        item_id TEXT PRIMARY KEY,
        response_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        item_index INTEGER NOT NULL,
        item_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS response_events (
        response_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        last_response_id TEXT
      );
      CREATE TABLE IF NOT EXISTS background_jobs (
        response_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT
      );
    `);
  }

  public createResponse(record: {
    id: string;
    createdAt: number;
    request: ResponsesCreateRequest;
    chatRequest: ChatCompletionRequest | null;
    response: ResponseObject;
    previousResponseId?: string | null;
    conversationId?: string | null;
    background?: boolean;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO responses (
            id, created_at, completed_at, status, request_json, chat_request_json,
            response_json, previous_response_id, conversation_id, background, cancel_requested, deleted
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
        `,
      )
      .run(
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

  public updateResponse(
    responseId: string,
    response: ResponseObject,
    chatRequest?: ChatCompletionRequest | null,
  ): void {
    this.db
      .prepare(
        `
          UPDATE responses
          SET response_json = ?, chat_request_json = COALESCE(?, chat_request_json), status = ?, completed_at = ?
          WHERE id = ?
        `,
      )
      .run(
        JSON.stringify(response),
        chatRequest === undefined ? null : chatRequest ? JSON.stringify(chatRequest) : null,
        response.status ?? "completed",
        response.completed_at ?? null,
        responseId,
      );
  }

  public setResponseStatus(responseId: string, status: string): void {
    const row = this.getResponseRow(responseId);
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

    this.updateResponse(responseId, current);
  }

  public markCancelRequested(responseId: string): void {
    this.db
      .prepare(`UPDATE responses SET cancel_requested = 1 WHERE id = ?`)
      .run(responseId);
  }

  public isCancelRequested(responseId: string): boolean {
    const row = this.db
      .prepare(`SELECT cancel_requested FROM responses WHERE id = ?`)
      .get(responseId) as { cancel_requested?: number } | undefined;
    return Boolean(row?.cancel_requested);
  }

  public deleteResponse(responseId: string): void {
    this.db.prepare(`UPDATE responses SET deleted = 1 WHERE id = ?`).run(responseId);
  }

  public storeItems(
    responseId: string,
    direction: "input" | "output",
    items: Array<ResponseInputItem | ResponseOutputItem>,
  ): void {
    const statement = this.db.prepare(
      `
        INSERT OR REPLACE INTO response_items (item_id, response_id, direction, item_index, item_json)
        VALUES (?, ?, ?, ?, ?)
      `,
    );

    for (const [index, item] of items.entries()) {
      const itemId =
        typeof item === "object" && item && "id" in item && typeof item.id === "string"
          ? item.id
          : `${responseId}_${direction}_${index}`;

      statement.run(itemId, responseId, direction, index, JSON.stringify(item));
    }
  }

  public clearItems(responseId: string, direction?: "input" | "output"): void {
    if (direction) {
      this.db
        .prepare(`DELETE FROM response_items WHERE response_id = ? AND direction = ?`)
        .run(responseId, direction);
      return;
    }

    this.db.prepare(`DELETE FROM response_items WHERE response_id = ?`).run(responseId);
  }

  public appendEvents(responseId: string, events: ResponseStreamEvent[]): void {
    const statement = this.db.prepare(
      `
        INSERT INTO response_events (response_id, sequence_number, event_type, event_json)
        VALUES (?, ?, ?, ?)
      `,
    );

    for (const [index, event] of events.entries()) {
      const sequenceNumber =
        typeof event.sequence_number === "number" ? event.sequence_number : index + 1;
      statement.run(responseId, sequenceNumber, event.type, JSON.stringify(event));
    }
  }

  public replaceEvents(responseId: string, events: ResponseStreamEvent[]): void {
    this.db.prepare(`DELETE FROM response_events WHERE response_id = ?`).run(responseId);
    this.appendEvents(responseId, events);
  }

  public getEvents(responseId: string): ResponseStreamEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_json FROM response_events WHERE response_id = ? ORDER BY sequence_number ASC`,
      )
      .all(responseId) as Array<{ event_json: string }>;

    return rows.map((row) => JSON.parse(row.event_json) as ResponseStreamEvent);
  }

  public getResponse(responseId: string): StoredResponse | null {
    const row = this.getResponseRow(responseId);
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
      inputItems: this.getItems<ResponseInputItem>(responseId, "input"),
      outputItems: this.getItems<ResponseOutputItem>(responseId, "output"),
      eventStream: this.getEvents(responseId)
    };
  }

  public getItems<T>(responseId: string, direction: "input" | "output"): T[] {
    const rows = this.db
      .prepare(
        `
          SELECT item_json
          FROM response_items
          WHERE response_id = ? AND direction = ?
          ORDER BY item_index ASC
        `,
      )
      .all(responseId, direction) as Array<{ item_json: string }>;

    return rows.map((row) => JSON.parse(row.item_json) as T);
  }

  public listInputItems(
    responseId: string,
    options?: { order?: "asc" | "desc"; limit?: number; after?: string | null },
  ): ResponseInputItem[] {
    let items = this.getItems<ResponseInputItem>(responseId, "input");

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

  public upsertConversation(id: string, lastResponseId: string): void {
    this.db
      .prepare(
        `
          INSERT INTO conversations (id, last_response_id)
          VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET last_response_id = excluded.last_response_id
        `,
      )
      .run(id, lastResponseId);
  }

  public getConversationResponses(id: string): StoredResponse[] {
    const rows = this.db
      .prepare(
        `
          SELECT id
          FROM responses
          WHERE conversation_id = ? AND deleted = 0
          ORDER BY created_at ASC
        `,
      )
      .all(id) as Array<{ id: string }>;

    return rows
      .map((row) => this.getResponse(row.id))
      .filter((row): row is StoredResponse => row !== null);
  }

  public getChainUntil(responseId: string): StoredResponse[] {
    const chain: StoredResponse[] = [];
    let cursor: string | null = responseId;

    while (cursor) {
      const response = this.getResponse(cursor);
      if (!response) {
        break;
      }

      chain.unshift(response);
      cursor = response.response.previous_response_id ?? null;
    }

    return chain;
  }

  public createBackgroundJob(responseId: string): void {
    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO background_jobs (response_id, state, started_at, finished_at, error)
          VALUES (?, 'queued', ?, NULL, NULL)
        `,
      )
      .run(responseId, Date.now());
  }

  public updateBackgroundJob(
    responseId: string,
    state: string,
    options?: { finished?: boolean; error?: string | null },
  ): void {
    this.db
      .prepare(
        `
          UPDATE background_jobs
          SET state = ?, finished_at = ?, error = COALESCE(?, error)
          WHERE response_id = ?
        `,
      )
      .run(state, options?.finished ? Date.now() : null, options?.error ?? null, responseId);
  }

  private getResponseRow(responseId: string): ResponseRow | null {
    const row = this.db
      .prepare(
        `
          SELECT id, request_json, chat_request_json, response_json, status, previous_response_id, conversation_id, deleted
          FROM responses
          WHERE id = ?
        `,
      )
      .get(responseId) as ResponseRow | undefined;

    return row ?? null;
  }
}
