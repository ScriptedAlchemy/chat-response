import type {
  ChatCompletionRequest,
  ResponseInputItem,
  ResponseObject,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponsesCreateRequest,
  StoredResponse
} from "../types/openai.js";
import type { ResponseStoreLike } from "./response-store.js";
import { generateTenantId, generateTenantSecret, hashTenantSecret } from "../utils/tenant.js";
import {
  openStoredJson,
  sealStoredJson,
  sealStoredText,
  type TenantEncryptionContext
} from "./encryption.js";

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

export class D1ResponseStore implements ResponseStoreLike {
  public constructor(
    private readonly db: D1Database,
    private readonly encryption?: TenantEncryptionContext,
  ) {}

  private prepare(sql: string, ...params: unknown[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(...(params as never[]));
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
    await this.prepare(
      `
        INSERT INTO responses (
          tenant_id, id, created_at, completed_at, status, request_json, chat_request_json,
          response_json, previous_response_id, conversation_id, background, cancel_requested, deleted
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
      `,
      tenantId,
      record.id,
      record.createdAt,
      record.response.completed_at ?? null,
      record.response.status ?? "in_progress",
      await sealStoredJson(record.request, this.encryption),
      record.chatRequest ? await sealStoredJson(record.chatRequest, this.encryption) : null,
      await sealStoredJson(record.response, this.encryption),
      record.previousResponseId ?? null,
      record.conversationId ?? null,
      record.background ? 1 : 0,
    ).run();
  }

  public async updateResponse(
    tenantId: string,
    responseId: string,
    response: ResponseObject,
    chatRequest?: ChatCompletionRequest | null,
  ): Promise<void> {
    await this.prepare(
      `
        UPDATE responses
        SET response_json = ?, chat_request_json = COALESCE(?, chat_request_json), status = ?, completed_at = ?
        WHERE tenant_id = ? AND id = ?
      `,
      await sealStoredJson(response, this.encryption),
      chatRequest === undefined ? null : chatRequest ? await sealStoredJson(chatRequest, this.encryption) : null,
      response.status ?? "completed",
      response.completed_at ?? null,
      tenantId,
      responseId,
    ).run();
  }

  public async setResponseStatus(tenantId: string, responseId: string, status: string): Promise<void> {
    const row = await this.getResponseRow(tenantId, responseId);
    if (!row) {
      return;
    }

    const current = await openStoredJson<ResponseObject>(row.response_json, this.encryption);
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
    await this.prepare(
      `UPDATE responses SET cancel_requested = 1 WHERE tenant_id = ? AND id = ?`,
      tenantId,
      responseId,
    ).run();
  }

  public async isCancelRequested(tenantId: string, responseId: string): Promise<boolean> {
    const rows = await this.prepare(
      `SELECT cancel_requested FROM responses WHERE tenant_id = ? AND id = ?`,
      tenantId,
      responseId,
    ).all<{ cancel_requested?: number }>();
    const row = rows.results?.[0];
    return Boolean(row?.cancel_requested);
  }

  public async deleteResponse(tenantId: string, responseId: string): Promise<void> {
    await this.prepare(
      `UPDATE responses SET deleted = 1 WHERE tenant_id = ? AND id = ?`,
      tenantId,
      responseId,
    ).run();
  }

  public async storeItems(
    tenantId: string,
    responseId: string,
    direction: "input" | "output",
    items: Array<ResponseInputItem | ResponseOutputItem>,
  ): Promise<void> {
    for (const [index, item] of items.entries()) {
      const itemId =
        typeof item === "object" && item && "id" in item && typeof item.id === "string"
          ? item.id
          : `${tenantId}_${responseId}_${direction}_${index}`;

      await this.prepare(
        `
          INSERT OR REPLACE INTO response_items (tenant_id, item_id, response_id, direction, item_index, item_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        tenantId,
        itemId,
        responseId,
        direction,
        index,
        await sealStoredJson(item, this.encryption),
      ).run();
    }
  }

  public async clearItems(
    tenantId: string,
    responseId: string,
    direction?: "input" | "output",
  ): Promise<void> {
    if (direction) {
      await this.prepare(
        `DELETE FROM response_items WHERE tenant_id = ? AND response_id = ? AND direction = ?`,
        tenantId,
        responseId,
        direction,
      ).run();
      return;
    }

    await this.prepare(
      `DELETE FROM response_items WHERE tenant_id = ? AND response_id = ?`,
      tenantId,
      responseId,
    ).run();
  }

  public async appendEvents(tenantId: string, responseId: string, events: ResponseStreamEvent[]): Promise<void> {
    for (const [index, event] of events.entries()) {
      const sequenceNumber =
        typeof event.sequence_number === "number" ? event.sequence_number : index + 1;
      await this.prepare(
        `
          INSERT INTO response_events (tenant_id, response_id, sequence_number, event_type, event_json)
          VALUES (?, ?, ?, ?, ?)
        `,
        tenantId,
        responseId,
        sequenceNumber,
        event.type,
        await sealStoredJson(event, this.encryption),
      ).run();
    }
  }

  public async replaceEvents(tenantId: string, responseId: string, events: ResponseStreamEvent[]): Promise<void> {
    await this.prepare(
      `DELETE FROM response_events WHERE tenant_id = ? AND response_id = ?`,
      tenantId,
      responseId,
    ).run();
    await this.appendEvents(tenantId, responseId, events);
  }

  public async getEvents(tenantId: string, responseId: string): Promise<ResponseStreamEvent[]> {
    const rows = await this.prepare(
      `SELECT event_json FROM response_events WHERE tenant_id = ? AND response_id = ? ORDER BY sequence_number ASC`,
      tenantId,
      responseId,
    ).all<{ event_json: string }>();

    return Promise.all(
      (rows.results ?? []).map(async (row) => {
        const event = await openStoredJson<ResponseStreamEvent>(row.event_json, this.encryption);
        if (!event) {
          throw new Error("Stored event payload could not be decoded.");
        }
        return event;
      }),
    );
  }

  public async getResponse(tenantId: string, responseId: string): Promise<StoredResponse | null> {
    const row = await this.getResponseRow(tenantId, responseId);
    if (!row || row.deleted) {
      return null;
    }

    const response = await openStoredJson<ResponseObject>(row.response_json, this.encryption);
    const request = await openStoredJson<ResponsesCreateRequest>(row.request_json, this.encryption);
    if (!response || !request) {
      return null;
    }

    return {
      id: responseId,
      request,
      chatRequest: await openStoredJson<ChatCompletionRequest>(row.chat_request_json, this.encryption),
      response,
      inputItems: await this.getItems<ResponseInputItem>(tenantId, responseId, "input"),
      outputItems: await this.getItems<ResponseOutputItem>(tenantId, responseId, "output"),
      eventStream: await this.getEvents(tenantId, responseId)
    };
  }

  public async getItems<T>(tenantId: string, responseId: string, direction: "input" | "output"): Promise<T[]> {
    const rows = await this.prepare(
      `
        SELECT item_json
        FROM response_items
        WHERE tenant_id = ? AND response_id = ? AND direction = ?
        ORDER BY item_index ASC
      `,
      tenantId,
      responseId,
      direction,
    ).all<{ item_json: string }>();

    return Promise.all(
      (rows.results ?? []).map(async (row) => {
        const item = await openStoredJson<T>(row.item_json, this.encryption);
        if (item === null) {
          throw new Error("Stored item payload could not be decoded.");
        }
        return item;
      }),
    );
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
    await this.prepare(
      `
        INSERT INTO conversations (tenant_id, id, last_response_id)
        VALUES (?, ?, ?)
        ON CONFLICT(tenant_id, id) DO UPDATE SET last_response_id = excluded.last_response_id
      `,
      tenantId,
      id,
      lastResponseId,
    ).run();
  }

  public async getConversationResponses(tenantId: string, id: string): Promise<StoredResponse[]> {
    const rows = await this.prepare(
      `
        SELECT id
        FROM responses
        WHERE tenant_id = ? AND conversation_id = ? AND deleted = 0
        ORDER BY created_at ASC
      `,
      tenantId,
      id,
    ).all<{ id: string }>();

    const responses = await Promise.all((rows.results ?? []).map((row) => this.getResponse(tenantId, row.id)));
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
    await this.prepare(
      `
        INSERT OR REPLACE INTO background_jobs (tenant_id, response_id, state, started_at, finished_at, error)
        VALUES (?, ?, 'queued', ?, NULL, NULL)
      `,
      tenantId,
      responseId,
      Date.now(),
    ).run();
  }

  public async updateBackgroundJob(
    tenantId: string,
    responseId: string,
    state: string,
    options?: { finished?: boolean; error?: string | null },
  ): Promise<void> {
    await this.prepare(
      `
        UPDATE background_jobs
        SET state = ?, finished_at = ?, error = COALESCE(?, error)
        WHERE tenant_id = ? AND response_id = ?
      `,
      state,
      options?.finished ? Date.now() : null,
      await sealStoredText(options?.error ?? null, this.encryption),
      tenantId,
      responseId,
    ).run();
  }

  public async createTenant(record: { tenantId?: string; label?: string | null } = {}): Promise<{
    tenantId: string;
    secret: string;
    label: string | null;
    createdAt: number;
  }> {
    const tenantId = record.tenantId ?? generateTenantId();
    const secret = generateTenantSecret();
    const secretHash = await hashTenantSecret(secret);
    const createdAt = Math.floor(Date.now() / 1000);

    await this.prepare(
      `
        INSERT INTO tenants (tenant_id, label, secret_hash, created_at, disabled, encryption_enabled)
        VALUES (?, ?, ?, ?, 0, 0)
      `,
      tenantId,
      record.label ?? null,
      secretHash,
      createdAt,
    ).run();

    return {
      tenantId,
      secret,
      label: record.label ?? null,
      createdAt
    };
  }

  public async getTenant(tenantId: string): Promise<{
    tenantId: string;
    label: string | null;
    secretHash: string;
    createdAt: number;
    disabled: boolean;
    encryptionEnabled: boolean;
  } | null> {
    const rows = await this.prepare(
      `
        SELECT tenant_id, label, secret_hash, created_at, disabled, encryption_enabled
        FROM tenants
        WHERE tenant_id = ?
      `,
      tenantId,
    ).all<{
      tenant_id: string;
      label: string | null;
      secret_hash: string;
      created_at: number;
      disabled: number;
      encryption_enabled: number;
    }>();

    const row = rows.results?.[0];
    if (!row) {
      return null;
    }

    return {
      tenantId: row.tenant_id,
      label: row.label ?? null,
      secretHash: row.secret_hash,
      createdAt: row.created_at,
      disabled: Boolean(row.disabled),
      encryptionEnabled: Boolean(row.encryption_enabled)
    };
  }

  private async getResponseRow(tenantId: string, responseId: string): Promise<ResponseRow | null> {
    const rows = await this.prepare(
      `
        SELECT id, request_json, chat_request_json, response_json, status, previous_response_id, conversation_id, deleted
        FROM responses
        WHERE tenant_id = ? AND id = ?
      `,
      tenantId,
      responseId,
    ).all<ResponseRow>();

    return rows.results?.[0] ?? null;
  }
}
