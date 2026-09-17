import { createServer } from "node:http";

const valueAfter = (name) => process.argv[process.argv.indexOf(name) + 1];
const host = valueAfter("--host");
const port = Number(valueAfter("--port"));
const apiKey = valueAfter("--api-key");

const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${apiKey}`) { response.writeHead(401); response.end(); return; }
  if (request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"ok"}'); return; }
  if (request.url === "/v1/chat/completions") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"llama"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    return;
  }
  response.writeHead(404); response.end();
});
server.listen(port, host);
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
