import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const MODELS = {
  qwen: {
    id: "qwen36-subagent",
    path: "/opt/fitz/llm/models/vllm/qwen3.6-35b-a3b-nvfp4",
    port: 8101,
    extraArgs: [
      "--tool-call-parser",
      "qwen3_xml",
      "--reasoning-parser",
      "qwen3",
    ],
  },
  nemotron: {
    id: "nemotron35-subagent",
    path:
      "/opt/fitz/llm/models/vllm/nemotron-3.5-lightning-30b-a3b-nvfp4",
    port: 8102,
    extraArgs: [
      "--tool-call-parser",
      "qwen3_coder",
      "--reasoning-parser",
      "nemotron_v3",
    ],
  },
};

const RUNTIME_DISTRIBUTION = "Fitz-Inference";
const VLLM = "/opt/fitz/llm/environments/vllm/bin/vllm";
const selected = process.argv[2];
const model = MODELS[selected];

if (!model) {
  console.error("Usage: node scripts/benchmark-vllm-concurrency.mjs qwen|nemotron");
  process.exit(2);
}

const concurrencyLevels = [1, 2, 4, 8, 12, 16];
const baseUrl = `http://127.0.0.1:${model.port}`;
const stdoutPath = join(tmpdir(), `fitz-vllm-${selected}.stdout.log`);
const stderrPath = join(tmpdir(), `fitz-vllm-${selected}.stderr.log`);
const stdout = createWriteStream(stdoutPath, { flags: "w" });
const stderr = createWriteStream(stderrPath, { flags: "w" });
const serverArgs = [
  "-d",
  RUNTIME_DISTRIBUTION,
  "--",
  VLLM,
  "serve",
  model.path,
  "--served-model-name",
  model.id,
  "--host",
  "0.0.0.0",
  "--port",
  String(model.port),
  "--quantization",
  "modelopt",
  "--max-model-len",
  "32768",
  "--max-num-seqs",
  "16",
  "--max-num-batched-tokens",
  "8192",
  "--kv-cache-dtype",
  "fp8",
  "--gpu-memory-utilization",
  "0.90",
  "--enable-prefix-caching",
  "-O2",
  "--enable-auto-tool-choice",
  ...model.extraArgs,
];

const serverStartedAt = performance.now();
const server = spawn("wsl.exe", serverArgs, {
  env: { ...process.env, VLLM_LOGGING_LEVEL: "INFO" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
server.stdout.pipe(stdout);
server.stderr.pipe(stderr);

let stopping = false;

function stopServer() {
  if (stopping) return;
  stopping = true;
  server.kill("SIGTERM");
  spawnSync(
    "wsl.exe",
    [
      "-d",
      RUNTIME_DISTRIBUTION,
      "--",
      "bash",
      "-lc",
      `pkill -TERM -f '${model.path}' || true`,
    ],
    { stdio: "ignore", windowsHide: true },
  );
}

process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopServer();
  process.exit(143);
});

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitUntilReady() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`vLLM exited before readiness with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Readiness polling deliberately ignores connection failures.
    }
    await sleep(5_000);
  }
  throw new Error("vLLM did not become ready within 20 minutes");
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function buildMessages(stage, worker) {
  const sharedUnit = [
    "Repository architecture evidence: the desktop process communicates with the host ",
    "through typed IPC. Model lifecycle, scheduling, recipes, artifacts, and sessions ",
    "must remain separate concerns. Every finding must cite the file that supports it. ",
  ].join("");
  const uniqueUnit = [
    `Worker ${worker} examines subsystem ${stage}-${worker}. `,
    "Identify ownership boundaries, failure behavior, and the smallest robust change. ",
  ].join("");
  return [
    {
      role: "system",
      content: `${sharedUnit.repeat(90)}\nBenchmark stage ${stage}.`,
    },
    {
      role: "user",
      content:
        `${uniqueUnit.repeat(65)}\n` +
        "Return a dense technical research memo. Continue until the output limit.",
    },
  ];
}

async function runRequest(stage, worker, maxTokens = 256) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      messages: buildMessages(stage, worker),
      temperature: 0,
      max_tokens: maxTokens,
      ignore_eos: true,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  let firstTokenAt;
  let usage;
  let buffered = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (event.usage) usage = event.usage;
      const delta = event.choices?.[0]?.delta;
      if (
        firstTokenAt === undefined &&
        (delta?.content || delta?.reasoning_content)
      ) {
        firstTokenAt = performance.now();
      }
    }
  }
  const finishedAt = performance.now();
  if (!usage) throw new Error("Streaming response did not include usage");
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    ttftSeconds: ((firstTokenAt ?? finishedAt) - startedAt) / 1_000,
    durationSeconds: (finishedAt - startedAt) / 1_000,
  };
}

async function runStage(concurrency) {
  const stageStartedAt = performance.now();
  const requests = await Promise.all(
    Array.from({ length: concurrency }, (_, worker) =>
      runRequest(concurrency, worker),
    ),
  );
  const wallSeconds = (performance.now() - stageStartedAt) / 1_000;
  const promptTokens = requests.reduce((sum, item) => sum + item.promptTokens, 0);
  const completionTokens = requests.reduce(
    (sum, item) => sum + item.completionTokens,
    0,
  );
  return {
    concurrency,
    wallSeconds,
    promptTokens,
    completionTokens,
    aggregateOutputTokensPerSecond: completionTokens / wallSeconds,
    averageTtftSeconds:
      requests.reduce((sum, item) => sum + item.ttftSeconds, 0) /
      requests.length,
    p95TtftSeconds: percentile(
      requests.map((item) => item.ttftSeconds),
      0.95,
    ),
    averageRequestTokensPerSecond:
      requests.reduce(
        (sum, item) => sum + item.completionTokens / item.durationSeconds,
        0,
      ) / requests.length,
  };
}

async function runToolValidation() {
  const tools = [
    {
      type: "function",
      function: {
        name: "search_files",
        description: "Search repository files for a literal text pattern.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            pattern: { type: "string" },
          },
          required: ["path", "pattern"],
          additionalProperties: false,
        },
      },
    },
  ];
  const cases = Array.from({ length: 8 }, (_, index) => ({
    path: `apps/subsystem-${index}`,
    pattern: `LifecycleBoundary${index}`,
  }));
  const responses = await Promise.all(
    cases.map(async (expected) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model.id,
          messages: [
            {
              role: "system",
              content:
                "You are a repository researcher. Use the provided tool exactly once.",
            },
            {
              role: "user",
              content: `Search ${expected.path} for ${expected.pattern}.`,
            },
          ],
          tools,
          tool_choice: "required",
          temperature: 0,
          max_tokens: 128,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (!response.ok) return { valid: false, error: await response.text() };
      const payload = await response.json();
      const call = payload.choices?.[0]?.message?.tool_calls?.[0];
      let args;
      try {
        args =
          typeof call?.function?.arguments === "string"
            ? JSON.parse(call.function.arguments)
            : call?.function?.arguments;
      } catch {
        return { valid: false, error: "invalid JSON arguments" };
      }
      return {
        valid:
          call?.function?.name === "search_files" &&
          args?.path === expected.path &&
          args?.pattern === expected.pattern,
        name: call?.function?.name,
        args,
      };
    }),
  );
  return {
    valid: responses.filter((response) => response.valid).length,
    total: responses.length,
    failures: responses.filter((response) => !response.valid),
  };
}

try {
  await waitUntilReady();
  const readySeconds = (performance.now() - serverStartedAt) / 1_000;
  await runRequest("warmup", 0, 32);
  const stages = [];
  for (const concurrency of concurrencyLevels) {
    console.error(`Running ${selected} at concurrency ${concurrency}`);
    stages.push(await runStage(concurrency));
  }
  const toolValidation = await runToolValidation();
  const gpu = spawnSync(
    "nvidia-smi",
    ["--query-compute-apps=pid,used_memory", "--format=csv,noheader"],
    { encoding: "utf8", windowsHide: true },
  );
  console.log(
    JSON.stringify(
      {
        model: selected,
        modelPath: model.path,
        readySeconds,
        stages,
        toolValidation,
        gpuProcesses: gpu.stdout.trim(),
        stdoutPath,
        stderrPath,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.stack ?? error.message);
  console.error(`vLLM logs: ${stdoutPath} ${stderrPath}`);
  process.exitCode = 1;
} finally {
  stopServer();
  stdout.end();
  stderr.end();
}
