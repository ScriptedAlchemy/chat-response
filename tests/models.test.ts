import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelListResponse, ModelObject } from "../src/types/openai.js";
import { startAdapterServer } from "./fixtures/adapter-server.js";
import { readJson } from "./json.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function startMockOpenAIServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer(async (req, res) => {
    const path = req.url?.split("?")[0];

    if (req.method === "GET" && path === "/v1/models") {
      const body: ModelListResponse = {
        object: "list",
        data: [
          { id: "glm-5", object: "model", created: 1, owned_by: "z-ai" },
          { id: "glm-5.1", object: "model", created: 2, owned_by: "z-ai" }
        ]
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "GET" && path === "/v1/models/glm-5") {
      const body: ModelObject = {
        id: "glm-5",
        object: "model",
        created: 1,
        owned_by: "z-ai"
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          created: 1,
          model: "glm-5",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "ok"
              }
            }
          ]
        })
      );
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock server");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

describe("models compatibility", () => {
  it("proxies the upstream models list and detail endpoints", async () => {
    const upstream = await startMockOpenAIServer();
    cleanups.push(upstream.close);

    const adapter = await startAdapterServer({
      upstream: {
        baseUrl: upstream.url
      }
    });
    cleanups.push(adapter.close);

    const listResponse = await fetch(`${adapter.url}/v1/models`);
    expect(listResponse.status).toBe(200);
    const listed = await readJson<ModelListResponse>(listResponse);
    expect(listed.object).toBe("list");
    expect(listed.data.map((model) => model.id)).toEqual(["glm-5", "glm-5.1"]);

    const retrieveResponse = await fetch(`${adapter.url}/v1/models/glm-5`);
    expect(retrieveResponse.status).toBe(200);
    const model = await readJson<ModelObject>(retrieveResponse);
    expect(model).toMatchObject({
      id: "glm-5",
      object: "model",
      owned_by: "z-ai"
    });
  });
});
