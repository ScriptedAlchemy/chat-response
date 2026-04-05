export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ResponseTextConfig {
  format?: unknown;
  verbosity?: "low" | "medium" | "high" | null;
}

export interface ResponsesCreateRequest {
  background?: boolean | null;
  conversation?: string | { id?: string | null; [key: string]: unknown } | null;
  include?: string[] | null;
  input?: string | ResponseInputItem[] | null;
  instructions?: string | null;
  max_output_tokens?: number | null;
  metadata?: Record<string, string> | null;
  model?: string;
  parallel_tool_calls?: boolean | null;
  previous_response_id?: string | null;
  prompt?: JsonValue | null;
  prompt_cache_key?: string;
  prompt_cache_retention?: "in-memory" | "24h" | null;
  reasoning?: {
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
    [key: string]: unknown;
  } | null;
  safety_identifier?: string;
  service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
  store?: boolean | null;
  stream?: boolean | null;
  stream_options?: {
    include_obfuscation?: boolean;
    [key: string]: unknown;
  } | null;
  temperature?: number | null;
  text?: ResponseTextConfig | null;
  tool_choice?: unknown;
  tools?: ResponseTool[] | null;
  top_p?: number | null;
  truncation?: "auto" | "disabled" | null;
  user?: string;
}

export interface ResponseTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean | null;
  [key: string]: unknown;
}

export interface ResponseInputMessagePart {
  type?: string;
  text?: string;
  input_text?: string;
  refusal?: string;
  image_url?: string;
  detail?: string;
  file_id?: string | null;
  file_url?: string | null;
  file_data?: string | null;
  filename?: string | null;
  input_audio?: {
    data: string;
    format: "mp3" | "wav";
  };
  [key: string]: unknown;
}

export interface ResponseInputItem {
  type?: string;
  role?: "user" | "assistant" | "system" | "developer";
  content?: string | ResponseInputMessagePart[];
  status?: string;
  id?: string;
  text?: string;
  image_url?: string;
  detail?: string;
  file_id?: string | null;
  file_url?: string | null;
  file_data?: string | null;
  filename?: string | null;
  call_id?: string;
  output?: unknown;
  name?: string;
  arguments?: string;
  input?: string;
  action?: unknown;
  actions?: unknown;
  operation?: unknown;
  [key: string]: unknown;
}

export interface ChatContentTextPart {
  type: "text";
  text: string;
}

export interface ChatContentImagePart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: string;
  };
}

export interface ChatContentFilePart {
  type: "file";
  file: {
    file_id?: string;
    file_data?: string;
    filename?: string;
  };
}

export interface ChatContentAudioPart {
  type: "input_audio";
  input_audio: {
    data: string;
    format: "mp3" | "wav";
  };
}

export type ChatContentPart =
  | ChatContentTextPart
  | ChatContentImagePart
  | ChatContentFilePart
  | ChatContentAudioPart;

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean | null;
  };
}

export interface ChatAssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: "developer" | "system" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[] | null;
  tool_calls?: ChatAssistantToolCall[];
  tool_call_id?: string;
  refusal?: string | null;
  name?: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model: string;
  metadata?: Record<string, string> | null;
  parallel_tool_calls?: boolean;
  max_completion_tokens?: number | null;
  reasoning_effort?: ResponsesCreateRequest["reasoning"] extends infer T
    ? T extends { effort?: infer U }
      ? U
      : never
    : never;
  response_format?: unknown;
  prompt_cache_key?: string;
  prompt_cache_retention?: "in-memory" | "24h" | null;
  safety_identifier?: string;
  service_tier?: ResponsesCreateRequest["service_tier"];
  store?: boolean | null;
  stream?: boolean | null;
  stream_options?: unknown;
  temperature?: number | null;
  tool_choice?: unknown;
  tools?: ChatTool[];
  top_p?: number | null;
  verbosity?: ResponseTextConfig["verbosity"];
}

export interface ChatCompletionChoice {
  index: number;
  finish_reason: string | null;
  message: {
    role: "assistant";
    content: string | null;
    refusal?: string | null;
    tool_calls?: ChatAssistantToolCall[];
  };
  logprobs?: {
    content?: JsonValue;
    refusal?: JsonValue;
  } | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  service_tier?: string | null;
}

export interface ModelObject {
  id: string;
  object: "model";
  created?: number;
  owned_by?: string;
}

export interface ModelListResponse {
  object: "list";
  data: ModelObject[];
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    delta: {
      role?: "assistant" | "tool" | "user" | "system" | "developer";
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

export interface ResponseOutputText {
  type: "output_text";
  text: string;
  annotations: JsonValue[];
  logprobs?: JsonValue[];
}

export interface ResponseOutputRefusal {
  type: "refusal";
  refusal: string;
}

export interface ResponseOutputMessage {
  id: string;
  type: "message";
  role: "assistant";
  status: "in_progress" | "completed" | "incomplete";
  content: Array<ResponseOutputText | ResponseOutputRefusal>;
  phase?: "commentary" | "final_answer" | null;
}

export interface ResponseFunctionToolCall {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: "in_progress" | "completed" | "incomplete";
}

export interface ResponseCustomToolCall {
  id: string;
  type: "custom_tool_call";
  call_id: string;
  name: string;
  input: string;
}

export interface ResponseApplyPatchCall {
  id: string;
  type: "apply_patch_call";
  call_id: string;
  status: "in_progress" | "completed";
  operation: unknown;
}

export interface ResponseShellCall {
  id: string;
  type: "shell_call";
  call_id: string;
  status: "in_progress" | "completed" | "incomplete";
  action: unknown;
  environment: unknown | null;
}

export interface ResponseComputerCall {
  id: string;
  type: "computer_call";
  call_id: string;
  status: "in_progress" | "completed" | "incomplete";
  pending_safety_checks: unknown[];
  action?: unknown;
  actions?: unknown;
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseFunctionToolCall
  | ResponseCustomToolCall
  | ResponseApplyPatchCall
  | ResponseShellCall
  | ResponseComputerCall;

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  output_text: string;
  error: {
    code: string;
    message: string;
  } | null;
  incomplete_details: {
    reason?: string;
  } | null;
  instructions: string | ResponseInputItem[] | null;
  metadata: Record<string, string> | null;
  model: string;
  output: ResponseOutputItem[];
  parallel_tool_calls: boolean;
  temperature: number | null;
  tool_choice?: unknown;
  tools: ResponseTool[];
  top_p: number | null;
  background?: boolean | null;
  completed_at?: number | null;
  conversation?: { id: string } | null;
  max_output_tokens?: number | null;
  previous_response_id?: string | null;
  prompt?: JsonValue | null;
  prompt_cache_key?: string;
  prompt_cache_retention?: "in-memory" | "24h" | null;
  reasoning?: unknown | null;
  safety_identifier?: string;
  service_tier?: string | null;
  status?: "queued" | "in_progress" | "completed" | "failed" | "incomplete" | "cancelled";
  text?: ResponseTextConfig | null;
  truncation?: "auto" | "disabled" | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    [key: string]: JsonValue | undefined;
  };
  user?: string;
}

export interface StoredResponse {
  id: string;
  request: ResponsesCreateRequest;
  chatRequest: ChatCompletionRequest | null;
  response: ResponseObject;
  inputItems: ResponseInputItem[];
  outputItems: ResponseOutputItem[];
  eventStream: ResponseStreamEvent[];
}

export interface ResponseStreamEvent {
  type: string;
  sequence_number?: number;
  [key: string]: unknown;
}

export interface InputItemListResponse {
  object: "list";
  data: ResponseInputItem[];
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
}

export interface InputTokenCountRequest {
  model?: string | null;
  input?: string | ResponseInputItem[] | null;
  instructions?: string | null;
  conversation?: ResponsesCreateRequest["conversation"];
  previous_response_id?: string | null;
  parallel_tool_calls?: boolean | null;
  reasoning?: Record<string, unknown> | null;
  text?: ResponseTextConfig | null;
  tool_choice?: unknown;
  tools?: ResponseTool[] | null;
  truncation?: "auto" | "disabled";
}

export interface CompactedResponse {
  id: string;
  created_at: number;
  object: "response.compaction";
  output: JsonValue[];
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}
