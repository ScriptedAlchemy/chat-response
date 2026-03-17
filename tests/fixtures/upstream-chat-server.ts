import { createServer } from "node:http";

import type { ChatCompletionRequest, ChatCompletionResponse } from "../../src/types/openai.js";

export interface MockChatReply {
  status?: number;
  json?: ChatCompletionResponse | { error: { message: string } };
  stream?: object[];
}

export async function startMockChatServer(
  handler: (request: ChatCompletionRequest) => Promise<MockChatReply> | MockChatReply,
): Promise<{
  url: string;
  requests: ChatCompletionRequest[];
  close: () => Promise<void>;
}> {
  const requests: ChatCompletionRequest[] = [];

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }

    const parsed = JSON.parse(body) as ChatCompletionRequest;
    requests.push(parsed);
    const reply = await handler(parsed);

    if (parsed.stream) {
      res.writeHead(reply.status ?? 200, {
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
        "cache-control": "no-cache"
      });

      for (const event of reply.stream ?? []) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(reply.status ?? 200, {
      "content-type": "application/json"
    });
    res.end(JSON.stringify(reply.json));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock server");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
