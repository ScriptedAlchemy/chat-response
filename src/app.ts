import Fastify from "fastify";

import type { AdapterConfig } from "./config.js";
import { registerErrorHandler, unauthorized } from "./errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerModelsRoutes } from "./routes/models.js";
import { registerResponsesRoutes } from "./routes/responses.js";
import { ResponseService } from "./services/response-service.js";
import { ResponseStore } from "./store/sqlite.js";
import { ChatCompletionsClient } from "./upstream/chat-client.js";

export function createApp(config: AdapterConfig) {
  const app = Fastify({
    logger: {
      level: config.logLevel
    }
  });

  const store = new ResponseStore(config.sqlitePath);
  const client = new ChatCompletionsClient(config.upstream);
  const service = new ResponseService(config, store, client, "local");

  app.addHook("onRequest", async (request) => {
    if (!config.adapterApiKey || request.url === "/health") {
      return;
    }

    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    const apiKeyHeader =
      typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : null;

    if (bearer !== config.adapterApiKey && apiKeyHeader !== config.adapterApiKey) {
      throw unauthorized();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    registerErrorHandler(request, reply, error);
  });

  void registerHealthRoutes(app);
  void registerModelsRoutes(app, client);
  void registerResponsesRoutes(app, service);

  return app;
}
