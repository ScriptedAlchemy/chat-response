import { afterEach, describe, expect, it } from "vitest";

import { startAdapterServer } from "./fixtures/adapter-server.js";
import { startMockChatServer } from "./fixtures/upstream-chat-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

describe("responses extended endpoints", () => {
  it("counts input tokens and returns compacted conversation output", async () => {
    const upstream = await startMockChatServer((request) => ({
      json: {
        id: "chatcmpl_compact",
        object: "chat.completion",
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Summary: user wants a proxy."
            }
          }
        ],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 6,
          total_tokens: 13
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

    const tokensResponse = await fetch(`${adapter.url}/v1/responses/input_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        input: "count these tokens"
      })
    });
    expect(tokensResponse.status).toBe(200);
    const tokens = await tokensResponse.json();
    expect(tokens.object).toBe("response.input_tokens");
    expect(tokens.input_tokens).toBeGreaterThan(0);

    const compactResponse = await fetch(`${adapter.url}/v1/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        input: "compact this thread"
      })
    });
    expect(compactResponse.status).toBe(200);
    const compact = await compactResponse.json();
    expect(compact.object).toBe("response.compaction");
    expect(compact.output[0]).toMatchObject({
      type: "compaction"
    });
    expect(compact.usage.total_tokens).toBe(13);
  });
});
