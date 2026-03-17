import { upstreamError } from "../errors.js";
import type { AdapterConfig } from "../config.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../types/openai.js";

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
    const response = await fetch(this.url(), {
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
    const response = await fetch(this.url(), {
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

  private url(): URL {
    const url = new URL(this.config.chatPath, `${this.config.baseUrl}/`);
    for (const [key, value] of Object.entries(this.config.queryParams)) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  private headers(): Headers {
    const headers = new Headers({
      "content-type": "application/json",
      ...this.config.headers
    });

    if (this.config.authMode === "bearer" && this.config.apiKey) {
      headers.set("authorization", `Bearer ${this.config.apiKey}`);
    } else if (this.config.authMode === "header" && this.config.apiKey) {
      headers.set(this.config.apiKeyHeader, this.config.apiKey);
    }

    return headers;
  }
}
