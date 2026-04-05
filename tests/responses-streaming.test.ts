import { afterEach, describe, expect, it } from "vitest";

import { startAdapterServer } from "./fixtures/adapter-server.js";
import { startMockChatServer } from "./fixtures/upstream-chat-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

describe("responses streaming", () => {
  it("transcodes chat completion chunks into responses SSE events", async () => {
    const upstream = await startMockChatServer((request) => ({
      stream: [
        {
          id: "chatcmpl_stream",
          object: "chat.completion.chunk",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: { role: "assistant", content: "Hello" }
            }
          ]
        },
        {
          id: "chatcmpl_stream",
          object: "chat.completion.chunk",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              delta: { content: " world" }
            }
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 2,
            total_tokens: 10
          }
        }
      ]
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
        input: "stream me",
        stream: true
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();

    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain("Hello");
    expect(body).toContain(" world");
    expect(body).toContain("event: response.completed");
    expect(body).toContain("data: [DONE]");
  });

  it("ignores upstream keepalive comment frames and still completes the stream", async () => {
    const upstream = await startMockChatServer((request) => ({
      rawStreamFrames: [": keep-alive\n\n"],
      stream: [
        {
          id: "chatcmpl_stream_keepalive",
          object: "chat.completion.chunk",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: { role: "assistant", content: "Hello" }
            }
          ]
        },
        {
          id: "chatcmpl_stream_keepalive",
          object: "chat.completion.chunk",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              delta: { content: " again" }
            }
          ]
        }
      ]
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
        input: "stream me",
        stream: true
      })
    });

    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain("Hello");
    expect(body).toContain(" again");
    expect(body).toContain("event: response.completed");
    expect(body).toContain("data: [DONE]");
  });

  it("ignores upstream empty data frames and still completes the stream", async () => {
    const upstream = await startMockChatServer((request) => ({
      rawStreamFrames: ["data:\n\n"],
      stream: [
        {
          id: "chatcmpl_stream_empty",
          object: "chat.completion.chunk",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: { role: "assistant", content: "Still" }
            }
          ]
        },
        {
          id: "chatcmpl_stream_empty",
          object: "chat.completion.chunk",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              delta: { content: " works" }
            }
          ]
        }
      ]
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
        input: "stream me",
        stream: true
      })
    });

    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain("Still");
    expect(body).toContain(" works");
    expect(body).toContain("event: response.completed");
    expect(body).toContain("data: [DONE]");
  });
});
