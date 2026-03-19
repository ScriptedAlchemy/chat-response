import { afterEach, describe, expect, it } from "vitest";

import { startAdapterServer } from "./fixtures/adapter-server.js";
import { startMockChatServer } from "./fixtures/upstream-chat-server.js";
import { readJson } from "./json.js";

type ErrorResponse = {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

describe("responses error handling", () => {
  it("returns explicit errors for unsupported prompt templates", async () => {
    const upstream = await startMockChatServer((request) => ({
      json: {
        id: "chatcmpl_unused",
        object: "chat.completion",
        created: 1,
        model: request.model,
        choices: []
      }
    }));
    cleanups.push(upstream.close);

    const adapter = await startAdapterServer({
      upstream: {
        baseUrl: upstream.url
      }
    });
    cleanups.push(adapter.close);

    const response = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        input: "hi",
        prompt: {
          id: "tmpl_123"
        }
      })
    });

    expect(response.status).toBe(400);
    const body = await readJson<ErrorResponse>(response);
    expect(body.error).toMatchObject({
      code: "invalid_request_error",
      param: "prompt"
    });
    expect(body.error.message).toContain("prompt templates");
  });

  it("surfaces upstream chat-completions errors in OpenAI-style envelopes", async () => {
    const upstream = await startMockChatServer(() => ({
      status: 429,
      json: {
        error: {
          message: "rate limit from provider"
        }
      }
    }));
    cleanups.push(upstream.close);

    const adapter = await startAdapterServer({
      upstream: {
        baseUrl: upstream.url
      }
    });
    cleanups.push(adapter.close);

    const response = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        input: "hi"
      })
    });

    expect(response.status).toBe(429);
    const body = await readJson<ErrorResponse>(response);
    expect(body.error).toMatchObject({
      code: "upstream_error",
      type: "server_error"
    });
    expect(body.error.message).toContain("rate limit from provider");
  });

  it("rejects file inputs when upstream file support is disabled", async () => {
    const upstream = await startMockChatServer((request) => ({
      json: {
        id: "chatcmpl_unused_files",
        object: "chat.completion",
        created: 1,
        model: request.model,
        choices: []
      }
    }));
    cleanups.push(upstream.close);

    const adapter = await startAdapterServer({
      upstream: {
        baseUrl: upstream.url,
        supportsFileParts: false
      }
    });
    cleanups.push(adapter.close);

    const response = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        input: [
          {
            type: "input_file",
            filename: "example.txt",
            file_data: "Zm9v"
          }
        ]
      })
    });

    expect(response.status).toBe(400);
    const body = await readJson<ErrorResponse>(response);
    expect(body.error).toMatchObject({
      code: "unsupported_feature"
    });
    expect(body.error.message).toContain("file part support");
  });
});
