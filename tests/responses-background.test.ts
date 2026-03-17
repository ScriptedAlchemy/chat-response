import { afterEach, describe, expect, it } from "vitest";

import { startAdapterServer } from "./fixtures/adapter-server.js";
import { startMockChatServer } from "./fixtures/upstream-chat-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

describe("responses background mode", () => {
  it("creates background responses that can be cancelled", async () => {
    const upstream = await startMockChatServer(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        json: {
          id: "chatcmpl_background",
          object: "chat.completion",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "late answer"
              }
            }
          ]
        }
      };
    });
    cleanups.push(upstream.close);

    const adapter = await startAdapterServer({
      upstream: {
        baseUrl: upstream.url
      }
    });
    cleanups.push(adapter.close);

    const createResponse = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        input: "work in background",
        background: true
      })
    });

    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    expect(["queued", "in_progress"]).toContain(created.status);

    const cancelResponse = await fetch(`${adapter.url}/v1/responses/${created.id}/cancel`, {
      method: "POST"
    });
    expect(cancelResponse.status).toBe(200);
    const cancelled = await cancelResponse.json();
    expect(cancelled.status).toBe("cancelled");

    const retrieved = await fetch(`${adapter.url}/v1/responses/${created.id}`);
    expect(retrieved.status).toBe(200);
    expect((await retrieved.json()).status).toBe("cancelled");
  });
});
