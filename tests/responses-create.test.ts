import { afterEach, describe, expect, it } from "vitest";

import { startAdapterServer } from "./fixtures/adapter-server.js";
import { startMockChatServer } from "./fixtures/upstream-chat-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

describe("responses create lifecycle", () => {
  it("creates, retrieves, lists input items, and deletes a response", async () => {
    const upstream = await startMockChatServer((request) => ({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hello from upstream"
            }
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14
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

    const createResponse = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        instructions: "You are terse.",
        input: "hello world"
      })
    });

    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    expect(created.object).toBe("response");
    expect(created.output_text).toBe("Hello from upstream");
    expect(created.status).toBe("completed");
    expect(created.output).toHaveLength(1);
    expect(upstream.requests[0]?.messages[0]).toMatchObject({
      role: "developer",
      content: "You are terse."
    });
    expect(upstream.requests[0]?.messages[1]).toMatchObject({
      role: "user",
      content: "hello world"
    });

    const retrievedResponse = await fetch(`${adapter.url}/v1/responses/${created.id}`);
    expect(retrievedResponse.status).toBe(200);
    const retrieved = await retrievedResponse.json();
    expect(retrieved.id).toBe(created.id);
    expect(retrieved.output_text).toBe("Hello from upstream");

    const inputItemsResponse = await fetch(
      `${adapter.url}/v1/responses/${created.id}/input_items?order=asc`,
    );
    expect(inputItemsResponse.status).toBe(200);
    const inputItems = await inputItemsResponse.json();
    expect(inputItems.data).toHaveLength(1);
    expect(inputItems.data[0]).toMatchObject({
      role: "user",
      type: "message",
      content: "hello world"
    });

    const deleteResponse = await fetch(`${adapter.url}/v1/responses/${created.id}`, {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(204);

    const missingResponse = await fetch(`${adapter.url}/v1/responses/${created.id}`);
    expect(missingResponse.status).toBe(404);
  });
});
