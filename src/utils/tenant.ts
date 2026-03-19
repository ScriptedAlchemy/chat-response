/// <reference types="@cloudflare/workers-types" />

import type { AdapterConfig } from "../config.js";

const textEncoder = new TextEncoder();

export type TenantUpstreamConfig = AdapterConfig["upstream"];

export interface TenantRecord {
  tenantId: string;
  label: string | null;
  secretHash: string;
  createdAt: number;
  disabled: boolean;
  encryptionEnabled: boolean;
  upstream: TenantUpstreamConfig | null;
}

export interface ProvisionedTenant {
  tenantId: string;
  tenantSecret: string;
  label: string | null;
  createdAt: number;
  upstream: TenantUpstreamConfig;
}

function randomHex(length = 24): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
}

export function createTenantId(): string {
  return `tenant_${randomHex(16)}`;
}

export function createTenantSecret(): string {
  return `tenant_${randomHex(48)}`;
}

export const generateTenantId = createTenantId;
export const generateTenantSecret = createTenantSecret;

export function tenantEndpointPath(tenantId: string): string {
  return `/t/${tenantId}`;
}

export async function hashTenantSecret(secret: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyTenantSecret(secret: string, secretHash: string): Promise<boolean> {
  return (await hashTenantSecret(secret)) === secretHash.toLowerCase();
}

function serializeRecord(record: Record<string, string>): string {
  return JSON.stringify(record);
}

function parseRecord(value: string | null): Record<string, string> {
  if (!value) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, String(entry)]));
}

export async function createTenant(
  db: D1Database,
  options: { label?: string | null; upstream: TenantUpstreamConfig },
): Promise<ProvisionedTenant> {
  const label = options.label ?? null;
  const { upstream } = options;

  for (;;) {
    const tenantId = createTenantId();
    const tenantSecret = createTenantSecret();
    const createdAt = Math.floor(Date.now() / 1000);
    const secretHash = await hashTenantSecret(tenantSecret);

    try {
      await db
        .prepare(
          `
            INSERT INTO tenants (
              tenant_id, label, secret_hash, created_at, disabled, encryption_enabled,
              upstream_base_url, upstream_chat_path, upstream_api_key, upstream_auth_mode,
              upstream_api_key_header, upstream_query_params, upstream_headers,
              upstream_supports_developer_role, upstream_supports_audio_input, upstream_supports_file_parts
            )
            VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .bind(
          tenantId,
          label,
          secretHash,
          createdAt,
          upstream.baseUrl,
          upstream.chatPath,
          upstream.apiKey ?? null,
          upstream.authMode,
          upstream.apiKeyHeader,
          serializeRecord(upstream.queryParams),
          serializeRecord(upstream.headers),
          upstream.supportsDeveloperRole ? 1 : 0,
          upstream.supportsAudioInput ? 1 : 0,
          upstream.supportsFileParts ? 1 : 0,
        )
        .run();

      return { tenantId, tenantSecret, label, createdAt, upstream };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("unique")) {
        continue;
      }
      throw error;
    }
  }
}

export async function getTenant(db: D1Database, tenantId: string): Promise<TenantRecord | null> {
  const rows = await db
    .prepare(
      `
        SELECT
          tenant_id,
          label,
          secret_hash,
          created_at,
          disabled,
          encryption_enabled,
          upstream_base_url,
          upstream_chat_path,
          upstream_api_key,
          upstream_auth_mode,
          upstream_api_key_header,
          upstream_query_params,
          upstream_headers,
          upstream_supports_developer_role,
          upstream_supports_audio_input,
          upstream_supports_file_parts
        FROM tenants
        WHERE tenant_id = ?
      `,
    )
    .bind(tenantId)
    .all<{
      tenant_id: string;
      label: string | null;
      secret_hash: string;
      created_at: number;
      disabled: number;
      encryption_enabled: number;
      upstream_base_url: string | null;
      upstream_chat_path: string | null;
      upstream_api_key: string | null;
      upstream_auth_mode: "bearer" | "header" | "none" | null;
      upstream_api_key_header: string | null;
      upstream_query_params: string | null;
      upstream_headers: string | null;
      upstream_supports_developer_role: number | null;
      upstream_supports_audio_input: number | null;
      upstream_supports_file_parts: number | null;
    }>();

  const row = rows.results?.[0];
  if (!row) {
    return null;
  }

  const upstream =
    row.upstream_base_url && row.upstream_chat_path && row.upstream_auth_mode && row.upstream_api_key_header
      ? {
          baseUrl: row.upstream_base_url,
          chatPath: row.upstream_chat_path,
          apiKey: row.upstream_api_key ?? undefined,
          authMode: row.upstream_auth_mode,
          apiKeyHeader: row.upstream_api_key_header,
          queryParams: parseRecord(row.upstream_query_params),
          headers: parseRecord(row.upstream_headers),
          supportsDeveloperRole: row.upstream_supports_developer_role !== 0,
          supportsAudioInput: row.upstream_supports_audio_input !== 0,
          supportsFileParts: row.upstream_supports_file_parts !== 0
        }
      : null;

  return {
    tenantId: row.tenant_id,
    label: row.label ?? null,
    secretHash: row.secret_hash,
    createdAt: row.created_at,
    disabled: Boolean(row.disabled),
    encryptionEnabled: Boolean(row.encryption_enabled),
    upstream
  };
}

export async function authorizeTenant(
  db: D1Database,
  tenantId: string,
  tenantSecret: string,
): Promise<TenantRecord | null> {
  const tenant = await getTenant(db, tenantId);
  if (!tenant || tenant.disabled) {
    return null;
  }

  const hash = await hashTenantSecret(tenantSecret);
  if (hash !== tenant.secretHash) {
    return null;
  }

  return tenant;
}

export function generateResponseTenantAlias(): string {
  return `tenant_${randomHex(24)}`;
}

export async function setTenantEncryptionEnabled(
  db: D1Database,
  tenantId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare(`UPDATE tenants SET encryption_enabled = ? WHERE tenant_id = ?`)
    .bind(enabled ? 1 : 0, tenantId)
    .run();
}

export async function tenantHasStoredResponses(db: D1Database, tenantId: string): Promise<boolean> {
  const rows = await db
    .prepare(`SELECT 1 AS present FROM responses WHERE tenant_id = ? LIMIT 1`)
    .bind(tenantId)
    .all<{ present: number }>();

  return Boolean(rows.results?.[0]?.present);
}
