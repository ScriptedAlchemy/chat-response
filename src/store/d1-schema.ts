/// <reference types="@cloudflare/workers-types" />

export const D1_SCHEMA_SQL = `
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
`;

export async function ensureD1Schema(db: D1Database): Promise<void> {
  await db.exec(D1_SCHEMA_SQL);
}
