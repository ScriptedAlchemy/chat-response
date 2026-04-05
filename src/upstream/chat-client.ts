import { upstreamError } from "../errors.js";
import type { AdapterConfig } from "../config.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelListResponse,
  ModelObject
} from "../types/openai.js";

async function parseErrorBody(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    return body?.error?.message ?? `Upstream request failed with status ${response.status}`;
  }

  return (await response.text().catch(() => "")) || `Upstream request failed with status ${response.status}`;
}

export class ChatCompletionsClient {
  private readonly config: AdapterConfig["upstream"];

  public constructor(config: AdapterConfig["upstream"]) {
    this.config = config;
  }

  public async create(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const response = await fetch(this.chatUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...request, stream: false }),
      signal
    });

    if (!response.ok) {
      throw upstreamError(response.status, await parseErrorBody(response));
    }

    return (await response.json()) as ChatCompletionResponse;
  }

  public async createStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(this.chatUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...request, stream: true }),
      signal
    });

    if (!response.ok) {
      throw upstreamError(response.status, await parseErrorBody(response));
    }

    if (!response.body) {
      throw upstreamError(502, "Upstream streaming response had no body.");
    }

    return response.body;
  }

  public async listModels(signal?: AbortSignal): Promise<ModelListResponse> {
    return (await this.getJson(this.modelsUrl(), signal)) as ModelListResponse;
  }

  public async retrieveModel(modelId: string, signal?: AbortSignal): Promise<ModelObject> {
    return (await this.getJson(this.modelsUrl(modelId), signal)) as ModelObject;
  }

  private async getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers(false),
      signal
    });

    if (!response.ok) {
      throw upstreamError(response.status, await parseErrorBody(response));
    }

    return await response.json();
  }

  private chatUrl(): URL {
    return this.urlForPath(this.config.chatPath);
  }

  private modelsUrl(modelId?: string): URL {
    const path = this.modelsPath();
    const suffix = modelId ? `/${encodeURIComponent(modelId)}` : "";
    return this.urlForPath(`${path}${suffix}`);
  }

  private modelsPath(): string {
    const normalized = this.config.chatPath.replace(/\/+$/, "");
    if (normalized.endsWith("/chat/completions")) {
      return `${normalized.slice(0, -"/chat/completions".length)}/models`;
    }

    if (normalized.endsWith("/responses")) {
      return `${normalized.slice(0, -"/responses".length)}/models`;
    }

    return "/v1/models";
  }

  private urlForPath(path: string): URL {
    const url = new URL(path, `${this.config.baseUrl}/`);
    for (const [key, value] of Object.entries(this.config.queryParams)) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  private headers(includeJsonContentType = true): Headers {
    const headers = new Headers(this.config.headers);

    if (includeJsonContentType) {
      headers.set("content-type", "application/json");
    }

    if (this.config.authMode === "bearer" && this.config.apiKey) {
      headers.set("authorization", `Bearer ${this.config.apiKey}`);
    } else if (this.config.authMode === "header" && this.config.apiKey) {
      headers.set(this.config.apiKeyHeader, this.config.apiKey);
    }

    return headers;
  }
}
