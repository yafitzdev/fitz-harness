export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  user?: string;
}

export interface InferenceRequest {
  id: string;
  routeId: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  userId?: string;
}

export interface InferenceDelta {
  text: string;
  finishReason?: "stop" | "length" | "cancelled";
  promptTokens?: number;
  completionTokens?: number;
}

export interface ModelCard {
  id: string;
  object: "model";
  created: number;
  owned_by: "fitz";
  display_name: string;
  description?: string;
}

export interface ModelListResponse {
  object: "list";
  data: ModelCard[];
}

export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
  };
}

export function parseChatCompletionRequest(value: unknown): ChatCompletionRequest {
  if (!isRecord(value)) {
    throw new TypeError("Request body must be a JSON object");
  }

  if (typeof value.model !== "string" || value.model.length === 0) {
    throw new TypeError("model must be a non-empty string");
  }

  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new TypeError("messages must be a non-empty array");
  }

  const messages = value.messages.map((message, index) => parseMessage(message, index));
  const request: ChatCompletionRequest = { model: value.model, messages };

  if (value.stream !== undefined) {
    if (typeof value.stream !== "boolean") throw new TypeError("stream must be a boolean");
    request.stream = value.stream;
  }
  if (value.max_tokens !== undefined) {
    if (!Number.isInteger(value.max_tokens) || (value.max_tokens as number) <= 0) {
      throw new TypeError("max_tokens must be a positive integer");
    }
    request.max_tokens = value.max_tokens as number;
  }
  if (value.temperature !== undefined) {
    if (typeof value.temperature !== "number" || !Number.isFinite(value.temperature)) {
      throw new TypeError("temperature must be a finite number");
    }
    request.temperature = value.temperature;
  }
  if (value.top_p !== undefined) {
    if (typeof value.top_p !== "number" || !Number.isFinite(value.top_p)) {
      throw new TypeError("top_p must be a finite number");
    }
    request.top_p = value.top_p;
  }
  if (value.stop !== undefined) {
    if (
      typeof value.stop !== "string" &&
      !(Array.isArray(value.stop) && value.stop.every((item) => typeof item === "string"))
    ) {
      throw new TypeError("stop must be a string or an array of strings");
    }
    request.stop = value.stop as string | string[];
  }
  if (value.user !== undefined) {
    if (typeof value.user !== "string") throw new TypeError("user must be a string");
    request.user = value.user;
  }

  return request;
}

function parseMessage(value: unknown, index: number): ChatMessage {
  if (!isRecord(value)) throw new TypeError(`messages[${index}] must be an object`);
  if (!isChatRole(value.role)) throw new TypeError(`messages[${index}].role is invalid`);
  if (typeof value.content !== "string") {
    throw new TypeError(`messages[${index}].content must be a string`);
  }

  const message: ChatMessage = { role: value.role, content: value.content };
  if (typeof value.name === "string") message.name = value.name;
  if (typeof value.tool_call_id === "string") message.tool_call_id = value.tool_call_id;
  return message;
}

function isChatRole(value: unknown): value is ChatRole {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
