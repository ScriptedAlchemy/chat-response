import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ResponseService } from "../services/response-service.js";
import type { ResponsesCreateRequest } from "../types/openai.js";

const createResponseSchema = z
  .object({
    model: z.string().min(1),
    input: z.any().optional(),
    instructions: z.string().nullable().optional(),
    metadata: z.record(z.string()).nullable().optional(),
    previous_response_id: z.string().nullable().optional(),
    conversation: z.union([z.string(), z.object({ id: z.string().optional().nullable() })]).nullable().optional(),
    background: z.boolean().nullable().optional(),
    include: z.array(z.string()).nullable().optional(),
    max_output_tokens: z.number().int().positive().nullable().optional(),
    parallel_tool_calls: z.boolean().nullable().optional(),
    prompt: z.any().nullable().optional(),
    prompt_cache_key: z.string().optional(),
    prompt_cache_retention: z.enum(["in-memory", "24h"]).nullable().optional(),
    reasoning: z.object({ effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).nullable().optional() }).passthrough().nullable().optional(),
    safety_identifier: z.string().optional(),
    service_tier: z.enum(["auto", "default", "flex", "scale", "priority"]).nullable().optional(),
    store: z.boolean().nullable().optional(),
    stream: z.boolean().nullable().optional(),
    stream_options: z.object({ include_obfuscation: z.boolean().optional() }).passthrough().nullable().optional(),
    temperature: z.number().nullable().optional(),
    text: z.object({ format: z.any().optional(), verbosity: z.enum(["low", "medium", "high"]).nullable().optional() }).passthrough().nullable().optional(),
    tool_choice: z.any().optional(),
    tools: z.array(z.record(z.any())).nullable().optional(),
    top_p: z.number().nullable().optional(),
    truncation: z.enum(["auto", "disabled"]).nullable().optional(),
    user: z.string().optional()
  })
  .passthrough();

const inputItemsQuerySchema = z.object({
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().positive().optional(),
  after: z.string().optional()
});

const retrieveQuerySchema = z.object({
  stream: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => value === true || value === "true")
});

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

    return service.getResponse(params.id).response;
  });

  app.delete("/v1/responses/:id", async (request, reply) => {
    const params = request.params as { id: string };
    service.deleteResponse(params.id);
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
