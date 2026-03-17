import type { FastifyReply, FastifyRequest } from "fastify";

export class OpenAIHttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly type: string;
  public readonly param?: string | null;

  public constructor(
    statusCode: number,
    code: string,
    message: string,
    options?: { type?: string; param?: string | null },
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.type = options?.type ?? "invalid_request_error";
    this.param = options?.param;
  }
}

export function invalidRequest(message: string, param?: string): OpenAIHttpError {
  return new OpenAIHttpError(400, "invalid_request_error", message, { param });
}

export function notFound(message: string): OpenAIHttpError {
  return new OpenAIHttpError(404, "not_found_error", message, { type: "not_found_error" });
}

export function unauthorized(message = "Unauthorized"): OpenAIHttpError {
  return new OpenAIHttpError(401, "authentication_error", message, {
    type: "authentication_error"
  });
}

export function upstreamError(statusCode: number, message: string): OpenAIHttpError {
  return new OpenAIHttpError(
    statusCode >= 400 && statusCode < 600 ? statusCode : 502,
    "upstream_error",
    message,
    { type: "server_error" },
  );
}

export function featureUnsupported(message: string): OpenAIHttpError {
  return new OpenAIHttpError(400, "unsupported_feature", message, { type: "invalid_request_error" });
}

export function sendError(reply: FastifyReply, error: OpenAIHttpError): void {
  reply.status(error.statusCode).send({
    error: {
      message: error.message,
      type: error.type,
      param: error.param ?? null,
      code: error.code
    }
  });
}

export function registerErrorHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): void {
  request.log.error(error);

  if (error instanceof OpenAIHttpError) {
    sendError(reply, error);
    return;
  }

  reply.status(500).send({
    error: {
      message: error instanceof Error ? error.message : "Internal server error",
      type: "server_error",
      param: null,
      code: "server_error"
    }
  });
}
