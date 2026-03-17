import { afterEach, describe, expect, it } from "vitest";

import { startAdapterServer } from "./fixtures/adapter-server.js";
import { startMockChatServer } from "./fixtures/upstream-chat-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

describe("responses state handling", () => {
  it("replays stored SSE events when retrieving with stream=true", async () => {
    const upstream = await startMockChatServer((request) => ({
      stream: [
        {
          id: "chatcmpl_state_stream",
          object: "chat.completion.chunk",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: { role: "assistant", content: "Replay" }
            }
          ]
        },
        {
          id: "chatcmpl_state_stream",
          object: "chat.completion.chunk",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              delta: { content: " me" }
            }
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7
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

    const createdResponse = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        input: "store replay",
        stream: true
      })
    });

    expect(createdResponse.status).toBe(200);
    const initialStream = await createdResponse.text();
    const responseIdMatch = initialStream.match(/"id":"(resp_[^"]+)"/);
    expect(responseIdMatch?.[1]).toBeTruthy();
    const responseId = responseIdMatch?.[1] as string;

    const replayResponse = await fetch(`${adapter.url}/v1/responses/${responseId}?stream=true`);
    expect(replayResponse.status).toBe(200);
    const replayStream = await replayResponse.text();

    expect(replayStream).toContain("event: response.created");
    expect(replayStream).toContain("event: response.output_text.delta");
    expect(replayStream).toContain("\"delta\":\"Replay\"");
    expect(replayStream).toContain("\"delta\":\" me\"");
    expect(replayStream).toContain("event: response.completed");
    expect(replayStream).toContain("data: [DONE]");
  });

  it("continues state using conversation ids", async () => {
    const upstream = await startMockChatServer((request) => ({
      json: {
        id: `chatcmpl_conv_${request.messages.length}`,
        object: "chat.completion",
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: `saw ${request.messages.length} messages`
            }
          }
        ]
      }
    }));
    cleanups.push(upstream.close);

    const adapter = await startAdapterServer({
      upstream: {
        baseUrl: upstream.url
      }
    });
    cleanups.push(adapter.close);

    const firstResponse = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        conversation: { id: "conv_shared" },
        input: "first turn"
      })
    });
    const first = await firstResponse.json();
    expect(firstResponse.status).toBe(200);
    expect(first.conversation).toEqual({ id: "conv_shared" });

    const secondResponse = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        conversation: "conv_shared",
        input: "second turn"
      })
    });
    const second = await secondResponse.json();
    expect(secondResponse.status).toBe(200);
    expect(second.conversation).toEqual({ id: "conv_shared" });
    expect(second.output_text).toBe("saw 3 messages");

    expect(upstream.requests[1]?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "first turn" }),
      expect.objectContaining({ role: "assistant", content: "saw 1 messages" }),
      expect.objectContaining({ role: "user", content: "second turn" })
    ]);
  });
});
