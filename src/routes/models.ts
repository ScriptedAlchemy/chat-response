import type { FastifyInstance } from "fastify";

import type { ChatCompletionsClient } from "../upstream/chat-client.js";

export async function registerModelsRoutes(
  app: FastifyInstance,
  client: ChatCompletionsClient,
): Promise<void> {
  app.get("/v1/models", async () => {
    return await client.listModels();
  });

  app.get("/v1/models/:model", async (request) => {
    const params = request.params as { model: string };
    return await client.retrieveModel(params.model);
  });
}
