import type { FastifyInstance } from "fastify";

import type { ResponseService } from "../services/response-service.js";
import type { ResponsesCreateRequest } from "../types/openai.js";
import {
  createResponseSchema,
  inputItemsQuerySchema,
  retrieveQuerySchema
} from "./responses-schema.js";

export async function registerResponsesRoutes(
  app: FastifyInstance,
  service: ResponseService,
): Promise<void> {
  app.post("/v1/responses", async (request, reply) => {
    const body = createResponseSchema.parse(request.body) as ResponsesCreateRequest;

    if (body.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive"
      });

      await service.createStream(body, async (chunk) => {
        reply.raw.write(chunk);
      });

      reply.raw.end();
      return;
    }

    const stored = await service.create(body);
    return stored.response;
  });

  app.get("/v1/responses/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const query = retrieveQuerySchema.parse(request.query);

    if (query.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive"
      });

      await service.replayResponseStream(params.id, async (chunk) => {
        reply.raw.write(chunk);
      });

      reply.raw.end();
      return;
    }

    return (await service.getResponse(params.id)).response;
  });

  app.delete("/v1/responses/:id", async (request, reply) => {
    const params = request.params as { id: string };
    await service.deleteResponse(params.id);
    reply.status(204).send();
  });

  app.post("/v1/responses/:id/cancel", async (request) => {
    const params = request.params as { id: string };
    return service.cancelResponse(params.id);
  });

  app.get("/v1/responses/:id/input_items", async (request) => {
    const params = request.params as { id: string };
    const query = inputItemsQuerySchema.parse(request.query);
    return service.listInputItems(params.id, query);
  });

  app.post("/v1/responses/input_tokens", async (request) => {
    const body = createResponseSchema.partial({ model: true }).parse(request.body);
    return service.countInputTokens(body as any);
  });

  app.post("/v1/responses/compact", async (request) => {
    const body = createResponseSchema.parse(request.body) as ResponsesCreateRequest;
    return service.compact(body);
  });
}
