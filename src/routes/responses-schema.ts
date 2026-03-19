import { z } from "zod";

export const createResponseSchema = z
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

export const inputItemsQuerySchema = z.object({
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().positive().optional(),
  after: z.string().optional()
});

export const retrieveQuerySchema = z.object({
  stream: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value: boolean | string | undefined) => value === true || value === "true")
});
