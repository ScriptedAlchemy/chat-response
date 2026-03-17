import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  SQLITE_PATH: z.string().default(".data/chat-response.db"),
  ADAPTER_API_KEY: z.string().optional(),
  UPSTREAM_BASE_URL: z.string().url(),
  UPSTREAM_CHAT_PATH: z.string().default("/v1/chat/completions"),
  UPSTREAM_API_KEY: z.string().optional(),
  UPSTREAM_AUTH_MODE: z.enum(["bearer", "header", "none"]).default("bearer"),
  UPSTREAM_API_KEY_HEADER: z.string().default("Authorization"),
  UPSTREAM_QUERY_PARAMS: z.string().default("{}"),
  UPSTREAM_HEADERS: z.string().default("{}"),
  UPSTREAM_SUPPORTS_DEVELOPER_ROLE: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false"),
  UPSTREAM_SUPPORTS_AUDIO_INPUT: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false"),
  UPSTREAM_SUPPORTS_FILE_PARTS: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false")
});

export interface AdapterConfig {
  host: string;
  port: number;
  logLevel: string;
  sqlitePath: string;
  adapterApiKey?: string;
  upstream: {
    baseUrl: string;
    chatPath: string;
    apiKey?: string;
    authMode: "bearer" | "header" | "none";
    apiKeyHeader: string;
    queryParams: Record<string, string>;
    headers: Record<string, string>;
    supportsDeveloperRole: boolean;
    supportsAudioInput: boolean;
    supportsFileParts: boolean;
  };
}

function parseObject(name: string, value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be an object");
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, entry]) => [key, String(entry)]),
    );
  } catch (error) {
    throw new Error(`Invalid JSON object in ${name}: ${String(error)}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const parsed = envSchema.parse(env);

  if (parsed.SQLITE_PATH !== ":memory:") {
    mkdirSync(dirname(parsed.SQLITE_PATH), { recursive: true });
  }

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    sqlitePath: parsed.SQLITE_PATH,
    adapterApiKey: parsed.ADAPTER_API_KEY,
    upstream: {
      baseUrl: parsed.UPSTREAM_BASE_URL.replace(/\/$/, ""),
      chatPath: parsed.UPSTREAM_CHAT_PATH,
      apiKey: parsed.UPSTREAM_API_KEY,
      authMode: parsed.UPSTREAM_AUTH_MODE,
      apiKeyHeader: parsed.UPSTREAM_API_KEY_HEADER,
      queryParams: parseObject("UPSTREAM_QUERY_PARAMS", parsed.UPSTREAM_QUERY_PARAMS),
      headers: parseObject("UPSTREAM_HEADERS", parsed.UPSTREAM_HEADERS),
      supportsDeveloperRole: parsed.UPSTREAM_SUPPORTS_DEVELOPER_ROLE,
      supportsAudioInput: parsed.UPSTREAM_SUPPORTS_AUDIO_INPUT,
      supportsFileParts: parsed.UPSTREAM_SUPPORTS_FILE_PARTS
    }
  };
}
