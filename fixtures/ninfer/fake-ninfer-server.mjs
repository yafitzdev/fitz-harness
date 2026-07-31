import http from "node:http";

const options = parseArguments(process.argv.slice(2));
const host = options.get("--host") ?? "127.0.0.1";
const port = Number.parseInt(options.get("--port") ?? "0", 10);
const apiKey = options.get("--api-key") ?? "";
const modelId = options.get("--model-id") ?? "fake-ninfer-model";

if (!Number.isInteger(port) || port < 1 || !apiKey) {
  process.stderr.write("missing required port or API key\n");
  process.exit(2);
}

const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${apiKey}`) {
    sendJson(response, 401, { error: { message: "unauthorized" } });
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { status: "ok", model: modelId });
    return;
  }

  if (request.method === "GET" && request.url === "/v1/models") {
    sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
    return;
  }

  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    const body = await readJson(request);
    const userText = [...(body.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "simulated " }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: userText }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
    return;
  }

  sendJson(response, 404, { error: { message: "not found" } });
});

server.listen(port, host, () => {
  process.stdout.write(`fake-ninfer ready on ${host}:${port}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals >= 0) values.set(argument.slice(0, equals), argument.slice(equals + 1));
    else if (args[index + 1] && !args[index + 1].startsWith("--")) {
      values.set(argument, args[index + 1]);
      index += 1;
    } else values.set(argument, "true");
  }
  return values;
}

async function readJson(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
