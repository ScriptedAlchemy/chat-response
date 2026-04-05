/// <reference types="@cloudflare/workers-types" />

import { z } from "zod";

import type { AdapterConfig } from "./config.js";
import { invalidRequest, notFound, OpenAIHttpError, unauthorized } from "./errors.js";
import { createResponseSchema, inputItemsQuerySchema, retrieveQuerySchema } from "./routes/responses-schema.js";
import { ResponseService } from "./services/response-service.js";
import { D1ResponseStore } from "./store/d1.js";
import type { TenantEncryptionContext } from "./store/encryption.js";
import type { InputTokenCountRequest, ResponsesCreateRequest } from "./types/openai.js";
import { ChatCompletionsClient } from "./upstream/chat-client.js";
import {
  createTenant,
  getTenant,
  setTenantEncryptionEnabled,
  tenantEndpointPath,
  tenantHasStoredResponses,
  type TenantRecord,
  type TenantUpstreamConfig,
  verifyTenantSecret
} from "./utils/tenant.js";

type WorkerEnv = Record<string, string | undefined> & {
  DB: D1Database;
};

const PROVIDER_API_ENV_KEY = "UPSTREAM_PROVIDER_API_KEY";
const TENANT_SECRET_HEADER = "X-Tenant-Secret";
const TENANT_SECRET_ENV_KEY = "CHAT_PROXY_TENANT_SECRET";

const optionalBooleanishField = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value === "boolean") {
      return value;
    }

    return !["false", "0", "off", "no"].includes(value.toLowerCase());
  });

type CapabilityDetection = {
  attempted: boolean;
  probeModel: string | null;
  message: string;
  capabilities: Pick<TenantUpstreamConfig, "supportsDeveloperRole" | "supportsAudioInput" | "supportsFileParts">;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseRecordField(name: string, value: unknown): Record<string, string> {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("must be a JSON object");
      }

      return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, String(entry)]));
    } catch (error) {
      throw invalidRequest(`Invalid JSON object in ${name}: ${String(error)}`);
    }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]),
    );
  }

  throw invalidRequest(`${name} must be a JSON object`, name);
}

const tenantProvisionSchema = z
  .object({
    label: z.string().trim().max(120).optional().nullable(),
    upstream_endpoint: z.string().url(),
    upstream_api_key: z.string().trim().min(1).optional().nullable(),
    probe_model: z.string().trim().min(1).optional().nullable(),
    upstream_auth_mode: z.enum(["bearer", "header", "none"]).default("bearer"),
    upstream_api_key_header: z.string().trim().min(1).default("Authorization"),
    upstream_query_params: z.unknown().optional(),
    upstream_headers: z.unknown().optional(),
    upstream_supports_developer_role: optionalBooleanishField,
    upstream_supports_audio_input: optionalBooleanishField,
    upstream_supports_file_parts: optionalBooleanishField
  })
  .transform((value) => {
    const endpoint = new URL(value.upstream_endpoint);
    const endpointParams = Object.fromEntries(endpoint.searchParams.entries());
    const extraQueryParams = parseRecordField("upstream_query_params", value.upstream_query_params);
    const extraHeaders = parseRecordField("upstream_headers", value.upstream_headers);

    return {
      label: value.label?.trim() ? value.label.trim() : null,
      upstreamEndpoint: value.upstream_endpoint,
      providerApiKey: value.upstream_api_key?.trim() ? value.upstream_api_key.trim() : null,
      probeModel: value.probe_model?.trim() ? value.probe_model.trim() : null,
      manualCapabilities: {
        supportsDeveloperRole: value.upstream_supports_developer_role,
        supportsAudioInput: value.upstream_supports_audio_input,
        supportsFileParts: value.upstream_supports_file_parts
      },
      upstream: {
        baseUrl: endpoint.origin,
        chatPath: endpoint.pathname || "/v1/chat/completions",
        apiKey: undefined,
        authMode: value.upstream_auth_mode,
        apiKeyHeader: value.upstream_api_key_header,
        queryParams: {
          ...endpointParams,
          ...extraQueryParams
        },
        headers: extraHeaders,
        supportsDeveloperRole: false,
        supportsAudioInput: false,
        supportsFileParts: false
      } satisfies TenantUpstreamConfig
    };
});

function parseBooleanString(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return !["false", "0", "off", "no"].includes(value.toLowerCase());
}

function legacyUpstreamFromEnv(env: WorkerEnv): TenantUpstreamConfig | null {
  if (!env.UPSTREAM_BASE_URL) {
    return null;
  }

  return {
    baseUrl: env.UPSTREAM_BASE_URL.replace(/\/$/, ""),
    chatPath: env.UPSTREAM_CHAT_PATH ?? "/v1/chat/completions",
    apiKey: env.UPSTREAM_API_KEY,
    authMode:
      env.UPSTREAM_AUTH_MODE === "header" || env.UPSTREAM_AUTH_MODE === "none"
        ? env.UPSTREAM_AUTH_MODE
        : "bearer",
    apiKeyHeader: env.UPSTREAM_API_KEY_HEADER ?? "Authorization",
    queryParams: parseRecordField("UPSTREAM_QUERY_PARAMS", env.UPSTREAM_QUERY_PARAMS ?? "{}"),
    headers: parseRecordField("UPSTREAM_HEADERS", env.UPSTREAM_HEADERS ?? "{}"),
    supportsDeveloperRole: parseBooleanString(env.UPSTREAM_SUPPORTS_DEVELOPER_ROLE, true),
    supportsAudioInput: parseBooleanString(env.UPSTREAM_SUPPORTS_AUDIO_INPUT, true),
    supportsFileParts: parseBooleanString(env.UPSTREAM_SUPPORTS_FILE_PARTS, true)
  };
}

function normalizeProbeText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

async function detectUpstreamCapabilities(
  upstream: TenantUpstreamConfig,
  options: {
    providerApiKey?: string | null;
    probeModel?: string | null;
  },
): Promise<CapabilityDetection> {
  const detection: CapabilityDetection = {
    attempted: false,
    probeModel: options.probeModel ?? null,
    message: "Capability probe skipped. Advanced capability flags defaulted to false.",
    capabilities: {
      supportsDeveloperRole: false,
      supportsAudioInput: false,
      supportsFileParts: false
    }
  };

  if (!options.probeModel) {
    return detection;
  }

  if (upstream.authMode !== "none" && !options.providerApiKey) {
    return {
      ...detection,
      probeModel: options.probeModel,
      message: "No provider API key was supplied for probing, so advanced capability flags defaulted to false."
    };
  }

  const probeClient = new ChatCompletionsClient({
    ...upstream,
    apiKey: options.providerApiKey ?? undefined
  });

  detection.attempted = true;

  try {
    const basicProbe = await probeClient.create({
      model: options.probeModel,
      messages: [
        {
          role: "user",
          content: "Reply with exactly BASICPROBE"
        }
      ],
      max_completion_tokens: 12,
      temperature: 0
    });

    const basicContent = normalizeProbeText(basicProbe.choices[0]?.message.content);
    const basicSucceeded = basicContent.includes("basicprobe");
    let developerProbeMessage =
      "Developer role support was not detected for the provided model. Audio and file-part support were left false by default.";

    try {
      const developerProbe = await probeClient.create({
        model: options.probeModel,
        messages: [
          {
            role: "developer",
            content: "Reply with exactly DEVONLY"
          },
          {
            role: "user",
            content: "Reply with exactly USERONLY"
          }
        ],
        max_completion_tokens: 12,
        temperature: 0
      });

      const content = normalizeProbeText(developerProbe.choices[0]?.message.content);
      detection.capabilities.supportsDeveloperRole = content.includes("devonly");

      if (detection.capabilities.supportsDeveloperRole) {
        developerProbeMessage =
          "Developer role support was detected for the provided model. Audio and file-part support were left false by default.";
      }
    } catch (error) {
      developerProbeMessage = `Basic probe worked, but developer-role probing failed: ${
        error instanceof Error ? error.message : String(error)
      }. Audio and file-part support were left false by default.`;
    }

    detection.message = basicSucceeded
      ? `Capability probe completed. ${developerProbeMessage}`
      : `Capability probe reached the endpoint, but the basic probe response was unexpected. ${developerProbeMessage}`;
  } catch (error) {
    detection.message = `Capability probe failed: ${
      error instanceof Error ? error.message : String(error)
    }. Advanced capability flags were left false by default.`;
  }

  return detection;
}

function mergeCapabilityFlags(
  detected: CapabilityDetection["capabilities"],
  manual: Partial<CapabilityDetection["capabilities"]>,
): CapabilityDetection["capabilities"] {
  return {
    supportsDeveloperRole: manual.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsAudioInput: manual.supportsAudioInput ?? detected.supportsAudioInput,
    supportsFileParts: manual.supportsFileParts ?? detected.supportsFileParts
  };
}

function workerAdapterConfig(upstream: TenantUpstreamConfig): AdapterConfig {
  return {
    host: "0.0.0.0",
    port: 0,
    logLevel: "info",
    sqlitePath: ":memory:",
    upstream
  };
}

function resolveTenantUpstream(env: WorkerEnv, tenant: TenantRecord): TenantUpstreamConfig {
  return tenant.upstream ?? legacyUpstreamFromEnv(env) ?? (() => {
    throw invalidRequest("This tenant does not have an upstream provider configured.");
  })();
}

function passthroughProviderApiKey(request: Request): string | undefined {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  const apiKeyHeader = request.headers.get("x-api-key");
  return apiKeyHeader || undefined;
}

function serviceForTenant(
  env: WorkerEnv,
  tenant: TenantRecord,
  request: Request,
  encryption?: TenantEncryptionContext,
): ResponseService {
  const resolvedUpstream = resolveTenantUpstream(env, tenant);
  const upstream = {
    ...resolvedUpstream,
    apiKey: passthroughProviderApiKey(request) ?? resolvedUpstream.apiKey
  };
  return new ResponseService(
    workerAdapterConfig(upstream),
    new D1ResponseStore(env.DB, encryption),
    new ChatCompletionsClient(upstream),
    tenant.tenantId,
  );
}

function upstreamClientForTenant(env: WorkerEnv, tenant: TenantRecord, request: Request): ChatCompletionsClient {
  const resolvedUpstream = resolveTenantUpstream(env, tenant);
  return new ChatCompletionsClient({
    ...resolvedUpstream,
    apiKey: passthroughProviderApiKey(request) ?? resolvedUpstream.apiKey
  });
}

function buildCodexConfigToml(baseUrl: string): string {
  return `[model_providers.chatproxy]
name = "Chat Proxy"
base_url = "${baseUrl}"
env_key = "${PROVIDER_API_ENV_KEY}"
wire_api = "responses"

[profiles.chatproxy]
model_provider = "chatproxy"
model = "gpt-5"
`;
}

function buildEncryptedCodexConfigToml(baseUrl: string): string {
  return `[model_providers.chatproxy]
name = "Chat Proxy"
base_url = "${baseUrl}"
env_key = "${PROVIDER_API_ENV_KEY}"
env_http_headers = { "${TENANT_SECRET_HEADER}" = "${TENANT_SECRET_ENV_KEY}" }
wire_api = "responses"

[profiles.chatproxy]
model_provider = "chatproxy"
model = "gpt-5"
`;
}

function buildSubagentProjectConfigToml(): string {
  return `[agents]
max_threads = 6
max_depth = 1
`;
}

function buildSubagentAgentToml(): string {
  return `name = "proxy_worker"
description = "Focused worker that inherits the parent proxy-backed Codex session."
developer_instructions = """
Stay tightly scoped to the assigned task.
Inherit the parent session's model provider/profile.
Prefer small, concrete changes and concise reports.
"""
`;
}

function buildCurlExample(responsesBaseUrl: string): string {
  return `curl -X POST ${responsesBaseUrl} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $${PROVIDER_API_ENV_KEY}" \\
  -d '{
    "model": "gpt-4o-mini",
    "input": "Write a short hello world message"
  }'`;
}

function buildEncryptedCurlExample(responsesBaseUrl: string): string {
  return `curl -X POST ${responsesBaseUrl} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $${PROVIDER_API_ENV_KEY}" \\
  -H "${TENANT_SECRET_HEADER}: $${TENANT_SECRET_ENV_KEY}" \\
  -d '{
    "model": "gpt-4o-mini",
    "input": "Write a short hello world message"
  }'`;
}

async function resolveTenantEncryption(
  db: D1Database,
  tenant: TenantRecord,
  request: Request,
): Promise<TenantEncryptionContext | undefined> {
  const tenantSecret = request.headers.get(TENANT_SECRET_HEADER);
  if (!tenantSecret) {
    if (tenant.encryptionEnabled) {
      throw unauthorized(`This tenant uses encrypted storage. Send the ${TENANT_SECRET_HEADER} header.`);
    }
    return undefined;
  }

  const validSecret = await verifyTenantSecret(tenantSecret, tenant.secretHash);
  if (!validSecret) {
    throw unauthorized(`Invalid ${TENANT_SECRET_HEADER} for this tenant.`);
  }

  if (!tenant.encryptionEnabled) {
    const hasStoredResponses = await tenantHasStoredResponses(db, tenant.tenantId);
    if (hasStoredResponses) {
      throw invalidRequest(
        `Encrypted storage can only be enabled before the first stored response for this tenant. Create a new tenant or continue without ${TENANT_SECRET_HEADER}.`,
      );
    }

    await setTenantEncryptionEnabled(db, tenant.tenantId, true);
    tenant.encryptionEnabled = true;
  }

  return {
    tenantId: tenant.tenantId,
    tenantSecret
  };
}

function landingPage(origin: string): Response {
  const tenantBaseUrl = `${origin}/t/<tenantHash>/v1`;
  const responsesBaseUrl = `${tenantBaseUrl}/responses`;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>chat-response worker</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe8;
        --bg-alt: #ebe2d6;
        --panel: rgba(255, 251, 246, 0.92);
        --panel-strong: #fffdf9;
        --ink: #191614;
        --muted: #6b6058;
        --accent: #0f694d;
        --accent-soft: rgba(15, 105, 77, 0.1);
        --border: rgba(85, 69, 54, 0.16);
        --danger: #a03f19;
        --shadow: 0 26px 70px rgba(48, 34, 23, 0.08);
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(15, 105, 77, 0.08), transparent 34%),
          linear-gradient(180deg, var(--bg) 0%, var(--bg-alt) 100%);
        color: var(--ink);
      }
      main {
        max-width: 1220px;
        margin: 0 auto;
        padding: 40px 20px 72px;
      }
      .shell {
        background: rgba(255, 252, 247, 0.78);
        border: 1px solid var(--border);
        border-radius: 28px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
        padding: 30px;
      }
      .eyebrow,
      .pill {
        display: inline-block;
        padding: 7px 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 700;
        font-size: 0.76rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.08fr) minmax(380px, 0.92fr);
        gap: 22px;
        align-items: start;
      }
      .hero-copy {
        display: grid;
        gap: 16px;
        min-width: 0;
      }
      h1 {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        font-size: clamp(2rem, 3.4vw, 3.7rem);
        line-height: 1.01;
        letter-spacing: -0.04em;
      }
      h2 {
        margin: 0;
        font-size: 1.06rem;
        letter-spacing: -0.01em;
      }
      h3 {
        margin: 0;
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--muted);
      }
      p, label, summary {
        line-height: 1.55;
      }
      .lead {
        max-width: 40rem;
        margin: 0;
        font-size: 1.05rem;
        color: var(--muted);
      }
      .mini-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .mini-card,
      .panel {
        min-width: 0;
        border: 1px solid var(--border);
        background: var(--panel);
      }
      .mini-card {
        border-radius: 18px;
        padding: 14px 16px;
      }
      .mini-card strong {
        display: block;
        margin-top: 4px;
        font-size: 0.95rem;
      }
      .stack {
        display: grid;
        gap: 14px;
      }
      .muted {
        color: var(--muted);
      }
      .danger {
        color: var(--danger);
      }
      .panel {
        border-radius: 22px;
        padding: 20px;
      }
      .panel--form {
        background: var(--panel-strong);
      }
      .panel--result {
        display: grid;
        gap: 16px;
      }
      form {
        display: grid;
        gap: 14px;
      }
      .field-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .form-grid {
        display: grid;
        gap: 12px;
      }
      label {
        display: grid;
        gap: 6px;
        font-weight: 600;
        font-size: 0.94rem;
      }
      input, textarea, select, button {
        font: inherit;
        border-radius: 14px;
        border: 1px solid var(--border);
        padding: 12px 14px;
        background: white;
        color: inherit;
        width: 100%;
      }
      input:focus,
      textarea:focus,
      select:focus {
        outline: 2px solid rgba(15, 105, 77, 0.18);
        border-color: rgba(15, 105, 77, 0.4);
      }
      textarea {
        min-height: 100px;
        resize: vertical;
      }
      .inline-note {
        margin: 0;
        font-size: 0.9rem;
        color: var(--muted);
      }
      .subtle-box {
        border: 1px solid var(--border);
        background: rgba(245, 239, 232, 0.68);
        border-radius: 18px;
        padding: 15px 16px;
        min-width: 0;
      }
      .subtle-box p {
        margin: 0;
      }
      .subtle-box code {
        display: block;
        margin-top: 6px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      button {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
        cursor: pointer;
        font-weight: 700;
        box-shadow: 0 12px 26px rgba(15, 105, 77, 0.18);
        transition: transform 140ms ease, box-shadow 140ms ease;
      }
      button:hover {
        transform: translateY(-1px);
      }
      button[disabled] {
        opacity: 0.7;
        cursor: progress;
        transform: none;
      }
      .button-row {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .checkbox-grid {
        display: grid;
        gap: 10px;
      }
      .checkbox {
        display: flex;
        align-items: center;
        gap: 10px;
        font-weight: 500;
      }
      .checkbox input {
        width: auto;
        margin: 0;
      }
      details {
        border: 1px dashed rgba(85, 69, 54, 0.24);
        border-radius: 16px;
        padding: 12px 14px;
        background: rgba(245, 239, 232, 0.44);
      }
      summary {
        cursor: pointer;
        font-weight: 700;
      }
      .result {
        margin-top: 18px;
      }
      .result[hidden] {
        display: none;
      }
      .result-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 16px;
      }
      .result-lead {
        margin: 0;
        color: var(--muted);
      }
      .snippet {
        display: grid;
        gap: 8px;
        min-width: 0;
      }
      .snippet__header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .snippet__meta {
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .copy-button {
        width: auto;
        min-width: 84px;
        padding: 9px 12px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: white;
        color: var(--ink);
        box-shadow: none;
      }
      .copy-button:hover {
        transform: none;
      }
      pre {
        margin: 0;
        background: #f4ede5;
        border-radius: 16px;
        padding: 0;
        overflow-x: auto;
        max-width: 100%;
        border: 1px solid rgba(85, 69, 54, 0.08);
      }
      pre code {
        display: block;
        padding: 16px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
        line-height: 1.5;
      }
      code {
        background: #f4ede5;
        border-radius: 8px;
        padding: 0.12rem 0.32rem;
      }
      .status {
        min-height: 1.4em;
        margin: 0;
        font-size: 0.94rem;
        flex: 1;
      }
      .status[data-state="working"] {
        color: var(--accent);
      }
      .footer-note {
        margin: 0;
        font-size: 0.88rem;
        color: var(--muted);
      }
      .warning-box {
        border: 1px solid rgba(160, 63, 25, 0.2);
        background: rgba(160, 63, 25, 0.07);
        border-radius: 18px;
        padding: 14px 16px;
      }
      .warning-box p {
        margin: 0;
      }
      @media (max-width: 920px) {
        .hero,
        .mini-grid,
        .result-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 720px) {
        main {
          padding: 18px 12px 28px;
        }
        .shell {
          padding: 18px;
          border-radius: 20px;
        }
        .field-grid {
          grid-template-columns: 1fr;
        }
        .button-row,
        .snippet__header {
          flex-direction: column;
          align-items: stretch;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="shell">
        <section class="hero">
          <div class="hero-copy">
            <div class="eyebrow">Responses Proxy</div>
            <h1>One tenant URL in front. Any chat-completions provider behind it.</h1>
            <p class="lead">Paste your upstream endpoint, optionally probe support, then copy the generated Responses API base URL into Codex. If you send <code>${TENANT_SECRET_HEADER}</code> from your first request onward, stored chats are encrypted so only the holder of that secret can decrypt them.</p>
            <div class="mini-grid">
              <div class="mini-card">
                <h3>Create</h3>
                <strong>Mint a unique tenant path</strong>
              </div>
              <div class="mini-card">
                <h3>Probe</h3>
                <strong>Store supported capabilities</strong>
              </div>
              <div class="mini-card">
                <h3>Use</h3>
                <strong>Point clients at one Responses URL</strong>
              </div>
            </div>
            <div class="subtle-box">
              <p><strong>Endpoint shape</strong><br /><code>${escapeHtml(responsesBaseUrl)}</code></p>
            </div>
          </div>
          <section class="panel panel--form">
            <div class="stack">
              <div class="stack" style="gap: 6px;">
                <div class="pill">Create Tenant</div>
                <h2>Upstream settings</h2>
                <p class="inline-note">The probe key is only used to test support during setup. Runtime requests still use your real upstream provider key.</p>
              </div>
              <form id="tenant-form">
                <div class="form-grid">
                  <label>
                    Upstream chat-completions endpoint
                    <input
                      name="upstream_endpoint"
                      type="url"
                      required
                      placeholder="https://openrouter.ai/api/v1/chat/completions"
                    />
                  </label>
                  <div class="field-grid">
                    <label>
                      Probe model
                      <input name="probe_model" placeholder="minimax/minimax-m2.7" />
                    </label>
                    <label>
                      Optional label
                      <input name="label" placeholder="openrouter-minimax" />
                    </label>
                  </div>
                  <label>
                    Provider API key for probe only, not stored
                    <input name="upstream_api_key" type="password" placeholder="sk-..." />
                  </label>
                </div>
                <details>
                  <summary>Advanced</summary>
                  <div class="stack" style="margin-top: 12px;">
                    <div class="field-grid">
                      <label>
                        Auth mode
                        <select name="upstream_auth_mode">
                          <option value="bearer">Bearer token</option>
                          <option value="header">Custom header</option>
                          <option value="none">None</option>
                        </select>
                      </label>
                      <label>
                        API key header
                        <input name="upstream_api_key_header" value="Authorization" />
                      </label>
                    </div>
                    <label>
                      Extra query params JSON
                      <textarea name="upstream_query_params" placeholder='{"api-version":"2025-04-01-preview"}'>{}</textarea>
                    </label>
                    <label>
                      Extra headers JSON
                      <textarea name="upstream_headers" placeholder='{"HTTP-Referer":"https://your-app.example"}'>{}</textarea>
                    </label>
                    <div class="checkbox-grid">
                      <label class="checkbox"><input type="checkbox" name="upstream_supports_developer_role" /> Force developer role support</label>
                      <label class="checkbox"><input type="checkbox" name="upstream_supports_audio_input" /> Force audio input support</label>
                      <label class="checkbox"><input type="checkbox" name="upstream_supports_file_parts" /> Force file part support</label>
                    </div>
                  </div>
                </details>
                <div class="button-row">
                  <button id="create-tenant" type="submit">Create tenant</button>
                  <p id="form-status" class="status muted"></p>
                </div>
              </form>
            </div>
          </section>
        </section>
        <section id="tenant-result" class="panel panel--result result" hidden>
          <div class="stack" style="gap: 6px;">
            <div class="pill">Tenant Ready</div>
            <h2>Copy this into your client</h2>
            <p class="result-lead">The tenant id scopes stored history. If you also send <code>${TENANT_SECRET_HEADER}</code>, stored chats are encrypted and only that secret can decrypt them later.</p>
          </div>
          <div class="result-grid">
            <div class="stack">
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>Responses base URL</h3>
                    <p class="muted">Use this as the Responses API base.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-responses-url">Copy</button>
                </div>
                <pre><code id="tenant-responses-url"></code></pre>
              </section>
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>Simple Codex config.toml</h3>
                    <p class="muted">Fastest setup. No encrypted storage header.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-config">Copy</button>
                </div>
                <pre><code id="tenant-config"></code></pre>
              </section>
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>Encrypted Codex config.toml</h3>
                    <p class="muted">Adds <code>${TENANT_SECRET_HEADER}</code> via <code>env_http_headers</code>.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-encrypted-config">Copy</button>
                </div>
                <pre><code id="tenant-encrypted-config"></code></pre>
              </section>
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>Provider API key env</h3>
                    <p class="muted">Set this to your upstream provider key.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-env">Copy</button>
                </div>
                <pre><code id="tenant-env"></code></pre>
              </section>
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>Tenant secret env</h3>
                    <p class="muted">Optional. Use this if you want encrypted chat storage.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-secret-env">Copy</button>
                </div>
                <pre><code id="tenant-secret-env"></code></pre>
              </section>
            </div>
            <div class="stack">
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>Tenant id</h3>
                    <p class="muted">Unique path segment for this tenant.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-id">Copy</button>
                </div>
                <pre><code id="tenant-id"></code></pre>
              </section>
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>One-time tenant secret</h3>
                    <p class="muted">Shown once. Required later if you want encrypted storage.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-secret">Copy</button>
                </div>
                <pre><code id="tenant-secret"></code></pre>
              </section>
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>Encrypted curl example</h3>
                    <p class="muted">Shows the header you send on every request for encrypted storage.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-encrypted-curl">Copy</button>
                </div>
                <pre><code id="tenant-encrypted-curl"></code></pre>
              </section>
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>Subagent project config</h3>
                    <p class="muted">Optional. Place in <code>.codex/config.toml</code> to tune agent fan-out.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-subagent-project-config">Copy</button>
                </div>
                <pre><code id="tenant-subagent-project-config"></code></pre>
              </section>
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>Custom subagent file</h3>
                    <p class="muted">Optional. Save as <code>.codex/agents/proxy_worker.toml</code>. It inherits the parent proxy-backed session.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-subagent-agent-config">Copy</button>
                </div>
                <pre><code id="tenant-subagent-agent-config"></code></pre>
              </section>
              <section class="snippet">
                <div class="snippet__header">
                  <div class="snippet__meta">
                    <h3>Detected capabilities</h3>
                    <p class="muted">Stored after probing.</p>
                  </div>
                  <button class="copy-button" type="button" data-copy-target="tenant-capabilities">Copy</button>
                </div>
                <pre><code id="tenant-capabilities"></code></pre>
              </section>
            </div>
          </div>
          <div class="warning-box">
            <p><strong>Recovery warning</strong><br /><span id="tenant-warning"></span></p>
          </div>
          <p class="footer-note">Detected flags are stored on the tenant so you only need to change them when you want a manual override.</p>
        </section>
      </div>
    </main>
    <script>
      const form = document.getElementById("tenant-form");
      const statusEl = document.getElementById("form-status");
      const resultEl = document.getElementById("tenant-result");
      const buttonEl = document.getElementById("create-tenant");

      const setStatus = (message, isError = false) => {
        statusEl.textContent = message;
        statusEl.className = isError ? "status danger" : "status muted";
        statusEl.dataset.state = isError ? "error" : message.includes("Creating tenant") ? "working" : "idle";
      };

      const fill = (id, value) => {
        const node = document.getElementById(id);
        if (node) {
          node.textContent = value;
        }
      };

      document.querySelectorAll("[data-copy-target]").forEach((button) => {
        button.addEventListener("click", async () => {
          const targetId = button.getAttribute("data-copy-target");
          const node = targetId ? document.getElementById(targetId) : null;
          const value = node?.textContent ?? "";
          if (!value) {
            return;
          }

          try {
            await navigator.clipboard.writeText(value);
            const previous = button.textContent;
            button.textContent = "Copied";
            setTimeout(() => {
              button.textContent = previous;
            }, 1200);
          } catch {
            button.textContent = "Failed";
            setTimeout(() => {
              button.textContent = "Copy";
            }, 1200);
          }
        });
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        buttonEl.disabled = true;
        setStatus("Creating tenant and probing endpoint-supported features...");

        const formData = new FormData(form);
        const payload = {
          label: formData.get("label"),
          upstream_endpoint: formData.get("upstream_endpoint"),
          upstream_api_key: formData.get("upstream_api_key"),
          probe_model: formData.get("probe_model"),
          upstream_auth_mode: formData.get("upstream_auth_mode"),
          upstream_api_key_header: formData.get("upstream_api_key_header"),
          upstream_query_params: formData.get("upstream_query_params"),
          upstream_headers: formData.get("upstream_headers")
        };

        if (formData.get("upstream_supports_developer_role") === "on") {
          payload.upstream_supports_developer_role = true;
        }
        if (formData.get("upstream_supports_audio_input") === "on") {
          payload.upstream_supports_audio_input = true;
        }
        if (formData.get("upstream_supports_file_parts") === "on") {
          payload.upstream_supports_file_parts = true;
        }

        try {
          const response = await fetch("/provision", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "accept": "application/json"
            },
            body: JSON.stringify(payload)
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data?.error?.message || "Tenant creation failed.");
          }

          fill("tenant-id", data.tenant_id);
          fill("tenant-secret", data.tenant_secret);
          fill("tenant-responses-url", data.responses_base_url);
          fill("tenant-encrypted-curl", data.encrypted_storage_curl_example);
          fill("tenant-config", data.codex_config_toml);
          fill("tenant-encrypted-config", data.codex_encrypted_config_toml);
          fill("tenant-env", data.codex_env_example);
          fill("tenant-secret-env", data.tenant_secret_env_example);
          fill("tenant-subagent-project-config", data.codex_subagent_project_config_toml);
          fill("tenant-subagent-agent-config", data.codex_subagent_agent_toml);
          fill("tenant-capabilities", JSON.stringify(data.detected_capabilities, null, 2));
          fill("tenant-warning", data.tenant_secret_warning);
          form.querySelector('input[name="upstream_supports_developer_role"]').checked = Boolean(data.detected_capabilities?.supportsDeveloperRole);
          form.querySelector('input[name="upstream_supports_audio_input"]').checked = Boolean(data.detected_capabilities?.supportsAudioInput);
          form.querySelector('input[name="upstream_supports_file_parts"]').checked = Boolean(data.detected_capabilities?.supportsFileParts);
          resultEl.hidden = false;
          form.querySelector('input[name="upstream_api_key"]').value = "";
          setStatus(data.probe_message || "Tenant created. Copy the generated URL into your client.");
          resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Tenant creation failed.", true);
        } finally {
          buttonEl.disabled = false;
        }
      });
    </script>
  </body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof OpenAIHttpError) {
    return Response.json(
      {
        error: {
          message: error.message,
          type: error.type,
          param: error.param ?? null,
          code: error.code
        }
      },
      { status: error.statusCode },
    );
  }

  return Response.json(
    {
      error: {
        message: error instanceof Error ? error.message : "Internal server error",
        type: "server_error",
        param: null,
        code: "server_error"
      }
    },
    { status: 500 },
  );
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

async function parseProvisioningBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json()) as Record<string, unknown>;
  }

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const values: Record<string, unknown> = {};
    form.forEach((value, key) => {
      values[key] = value;
    });
    return values;
  }

  return {};
}

async function handleProvision(request: Request, env: WorkerEnv): Promise<Response> {
  const body = tenantProvisionSchema.parse(await parseProvisioningBody(request));
  const detection = await detectUpstreamCapabilities(body.upstream, {
    providerApiKey: body.providerApiKey,
    probeModel: body.probeModel
  });
  const storedCapabilities = mergeCapabilityFlags(detection.capabilities, body.manualCapabilities);
  const created = await createTenant(env.DB, {
    label: body.label,
    upstream: {
      ...body.upstream,
      ...storedCapabilities
    }
  });

  const origin = new URL(request.url).origin;
  const tenantBasePath = tenantEndpointPath(created.tenantId);
  const tenantBaseUrl = `${origin}${tenantBasePath}/v1`;
  const responsesBaseUrl = `${tenantBaseUrl}/responses`;

  return Response.json({
    tenant_id: created.tenantId,
    tenant_secret: created.tenantSecret,
    tenant_label: created.label,
    tenant_base_path: tenantBasePath,
    tenant_base_url: tenantBaseUrl,
    responses_base_url: responsesBaseUrl,
    upstream_endpoint: body.upstreamEndpoint,
    probe_attempted: detection.attempted,
    probe_model: detection.probeModel,
    probe_message: detection.message,
    detected_capabilities: storedCapabilities,
    curl_example: buildCurlExample(responsesBaseUrl),
    encrypted_storage_curl_example: buildEncryptedCurlExample(responsesBaseUrl),
    codex_config_toml: buildCodexConfigToml(tenantBaseUrl),
    codex_encrypted_config_toml: buildEncryptedCodexConfigToml(tenantBaseUrl),
    codex_subagent_project_config_toml: buildSubagentProjectConfigToml(),
    codex_subagent_agent_toml: buildSubagentAgentToml(),
    codex_env_key: PROVIDER_API_ENV_KEY,
    codex_env_example: `${PROVIDER_API_ENV_KEY}="your_real_provider_api_key"`,
    tenant_secret_header: TENANT_SECRET_HEADER,
    tenant_secret_env_key: TENANT_SECRET_ENV_KEY,
    tenant_secret_env_example: `${TENANT_SECRET_ENV_KEY}="${created.tenantSecret}"`,
    tenant_secret_warning:
      "If you start using X-Tenant-Secret for this tenant and later lose both the tenant id and secret, encrypted sessions cannot be recovered."
  });
}

async function handleTenantApi(
  request: Request,
  env: WorkerEnv,
  tenantId: string,
  path: string,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const tenant = await getTenant(env.DB, tenantId);
    if (!tenant) {
      throw notFound(`No tenant found with id '${tenantId}'.`);
    }

    const encryption = await resolveTenantEncryption(env.DB, tenant, request);
    const upstreamClient = upstreamClientForTenant(env, tenant, request);
    const service = serviceForTenant(env, tenant, request, encryption);

    if (request.method === "GET" && (path === "" || path === "/")) {
      return Response.json({
        tenant_id: tenantId,
        base_path: tenantEndpointPath(tenantId),
        responses_base_url: `${new URL(request.url).origin}${tenantEndpointPath(tenantId)}/v1/responses`,
        encrypted_storage: tenant.encryptionEnabled,
        tenant_secret_header: TENANT_SECRET_HEADER
      });
    }

    if (request.method === "POST" && path === "/v1/responses") {
      const body = createResponseSchema.parse(await parseJsonBody<unknown>(request)) as ResponsesCreateRequest;
      if (body.stream) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              void service
                .createStream(body, async (chunk: string) => {
                  controller.enqueue(new TextEncoder().encode(chunk));
                })
                .then(() => controller.close())
                .catch((error: unknown) => controller.error(error));
            }
          }),
          {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive"
            }
          }
        );
      }

      const created = await service.create(body, {
        waitUntil: (task: Promise<unknown>) => ctx.waitUntil(task)
      });
      return Response.json(created.response);
    }

    if (request.method === "GET" && path === "/v1/models") {
      return Response.json(await upstreamClient.listModels());
    }

    if (request.method === "GET" && path.startsWith("/v1/models/")) {
      const modelId = decodeURIComponent(path.slice("/v1/models/".length));
      return Response.json(await upstreamClient.retrieveModel(modelId));
    }

    if (request.method === "GET" && path.startsWith("/v1/responses/") && path.endsWith("/input_items")) {
      const responseId = decodeURIComponent(path.slice("/v1/responses/".length, -"/input_items".length));
      const url = new URL(request.url);
      const query = inputItemsQuerySchema.parse({
        order: url.searchParams.get("order") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        after: url.searchParams.get("after") ?? undefined
      });
      return Response.json(await service.listInputItems(responseId, query));
    }

    if (request.method === "GET" && path.startsWith("/v1/responses/")) {
      const responseId = decodeURIComponent(path.slice("/v1/responses/".length));
      const url = new URL(request.url);
      const query = retrieveQuerySchema.parse({
        stream: url.searchParams.get("stream") ?? undefined
      });

      if (query.stream) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              void service
                .replayResponseStream(
                  responseId,
                  async (chunk: string) => {
                    controller.enqueue(new TextEncoder().encode(chunk));
                  },
                )
                .then(() => controller.close())
                .catch((error: unknown) => controller.error(error));
            }
          }),
          {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive"
            }
          }
        );
      }

      return Response.json((await service.getResponse(responseId)).response);
    }

    if (request.method === "DELETE" && path.startsWith("/v1/responses/")) {
      const responseId = decodeURIComponent(path.slice("/v1/responses/".length));
      await service.deleteResponse(responseId);
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && path.startsWith("/v1/responses/") && path.endsWith("/cancel")) {
      const responseId = decodeURIComponent(path.slice("/v1/responses/".length, -"/cancel".length));
      return Response.json(await service.cancelResponse(responseId));
    }

    if (request.method === "POST" && path === "/v1/responses/input_tokens") {
      const body = createResponseSchema.partial({ model: true }).parse(await parseJsonBody<unknown>(request)) as InputTokenCountRequest;
      return Response.json(await service.countInputTokens(body));
    }

    if (request.method === "POST" && path === "/v1/responses/compact") {
      const body = createResponseSchema.parse(await parseJsonBody<unknown>(request)) as ResponsesCreateRequest;
      return Response.json(await service.compact(body));
    }

    throw notFound("Not Found");
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return landingPage(url.origin);
    }

    if (request.method === "POST" && url.pathname === "/provision") {
      try {
        return await handleProvision(request, env);
      } catch (error) {
        return errorResponse(error);
      }
    }

    const tenantMatch = url.pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
    if (tenantMatch) {
      const tenantIdSegment = tenantMatch[1];
      if (!tenantIdSegment) {
        return errorResponse(notFound("Not Found"));
      }

      const tenantId = decodeURIComponent(tenantIdSegment);
      const path = tenantMatch[2] ?? "/";
      return handleTenantApi(request, env, tenantId, path, ctx);
    }

    return errorResponse(notFound("Not Found"));
  }
};
