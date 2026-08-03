export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ChatToolChoice = "none" | "auto" | "required" | {
  type: "function";
  function: { name: string };
};

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
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
  tools?: ChatCompletionTool[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
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
  tools?: ChatCompletionTool[];
  toolChoice?: ChatToolChoice;
  parallelToolCalls?: boolean;
}

export interface InferenceDelta {
  text: string;
  toolCalls?: ChatToolCallDelta[];
  finishReason?: "stop" | "length" | "tool_calls" | "cancelled";
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
  if (value.tools !== undefined) request.tools = parseTools(value.tools);
  if (value.tool_choice !== undefined) request.tool_choice = parseToolChoice(value.tool_choice);
  if (value.parallel_tool_calls !== undefined) {
    if (typeof value.parallel_tool_calls !== "boolean") throw new TypeError("parallel_tool_calls must be a boolean");
    request.parallel_tool_calls = value.parallel_tool_calls;
  }

  return request;
}

function parseMessage(value: unknown, index: number): ChatMessage {
  if (!isRecord(value)) throw new TypeError(`messages[${index}] must be an object`);
  if (!isChatRole(value.role)) throw new TypeError(`messages[${index}].role is invalid`);
  const message: ChatMessage = { role: value.role, content: parseMessageContent(value.content, index) };
  if (typeof value.name === "string") message.name = value.name;
  if (typeof value.tool_call_id === "string") message.tool_call_id = value.tool_call_id;
  if (value.tool_calls !== undefined) {
    if (value.role !== "assistant") throw new TypeError(`messages[${index}].tool_calls requires the assistant role`);
    message.tool_calls = parseToolCalls(value.tool_calls, `messages[${index}].tool_calls`);
  }
  return message;
}

function parseMessageContent(value: unknown, index: number): string | ChatContentPart[] {
  if (typeof value === "string") return value;
  if (value === null) return "";
  if (Array.isArray(value) && value.length > 0) {
    const parts: ChatContentPart[] = value.map((part, partIndex) => {
      if (isRecord(part) && (part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
        return { type: "text" as const, text: part.text };
      }
      if (isRecord(part) && part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
        return { type: "image_url" as const, image_url: { url: part.image_url.url } };
      }
      throw new TypeError(`messages[${index}].content[${partIndex}] must be a text or image_url part`);
    });
    // Normalize: if all parts are text, collapse into a single string
    if (parts.every((p) => p.type === "text")) return parts.map((p) => p.text).join("");
    return parts;
  }
  throw new TypeError(`messages[${index}].content must be a string or content parts array`);
}

function parseTools(value: unknown): ChatCompletionTool[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("tools must be a non-empty array");
  return value.map((item, index) => {
    if (!isRecord(item) || item.type !== "function" || !isRecord(item.function)) throw new TypeError(`tools[${index}] must be a function tool`);
    const definition = item.function;
    if (typeof definition.name !== "string" || !definition.name) throw new TypeError(`tools[${index}].function.name must be a non-empty string`);
    if (!isRecord(definition.parameters)) throw new TypeError(`tools[${index}].function.parameters must be an object`);
    if (definition.description !== undefined && typeof definition.description !== "string") throw new TypeError(`tools[${index}].function.description must be a string`);
    if (definition.strict !== undefined && typeof definition.strict !== "boolean") throw new TypeError(`tools[${index}].function.strict must be a boolean`);
    return {
      type: "function",
      function: {
        name: definition.name,
        parameters: definition.parameters,
        ...(typeof definition.description === "string" ? { description: definition.description } : {}),
        ...(typeof definition.strict === "boolean" ? { strict: definition.strict } : {}),
      },
    };
  });
}

function parseToolChoice(value: unknown): ChatToolChoice {
  if (value === "none" || value === "auto" || value === "required") return value;
  if (!isRecord(value) || value.type !== "function" || !isRecord(value.function) || typeof value.function.name !== "string" || !value.function.name) {
    throw new TypeError("tool_choice must be none, auto, required, or a named function");
  }
  return { type: "function", function: { name: value.function.name } };
}

function parseToolCalls(value: unknown, name: string): ChatToolCall[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${name} must be a non-empty array`);
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || item.type !== "function" || !isRecord(item.function)
      || typeof item.function.name !== "string" || typeof item.function.arguments !== "string") {
      throw new TypeError(`${name}[${index}] must be a function call`);
    }
    return { id: item.id, type: "function", function: { name: item.function.name, arguments: item.function.arguments } };
  });
}

function isChatRole(value: unknown): value is ChatRole {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
