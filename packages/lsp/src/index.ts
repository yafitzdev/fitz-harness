import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type LspOperation = "goToDefinition" | "findReferences" | "goToImplementation" | "hover";

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspQueryRequest {
  readonly operation: LspOperation;
  readonly filePath: string;
  readonly position: LspPosition;
  readonly workspaceRoot: string;
}

export interface LspProviderQuery extends LspQueryRequest {
  readonly languageId: string;
}

export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

export interface LspHover {
  readonly contents: string;
  readonly range?: LspRange;
}

export type LspQueryResult =
  | { readonly kind: "locations"; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: "hover"; readonly hover: LspHover | null };

export type LspErrorCode =
  | "LSP_INVALID_REQUEST"
  | "LSP_UNAVAILABLE"
  | "LSP_UNSUPPORTED_OPERATION"
  | "LSP_SOURCE_INVALID"
  | "LSP_SOURCE_TOO_LARGE"
  | "LSP_TIMEOUT"
  | "LSP_PROTOCOL"
  | "LSP_PROCESS";

export class LspError extends Error {
  readonly code: LspErrorCode;

  constructor(message: string, code: LspErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LspError";
    this.code = code;
  }
}

export interface LspProvider {
  readonly id: string;
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>;
  dispose?(): Promise<void>;
}

export interface LspService {
  registerProvider(provider: LspProvider): () => void;
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>;
  dispose(): Promise<void>;
}

/**
 * The host-owned LSP registry. Provider selection is based only on the source extension;
 * the model never chooses a process, command, or transport.
 */
export class LspRegistry implements LspService {
  readonly #providers = new Map<string, LspProvider>();
  readonly #extensions = new Map<string, { provider: LspProvider; languageId: string }>();

  registerProvider(provider: LspProvider): () => void {
    validateProvider(provider);
    const id = provider.id.trim();
    const extensions = Object.entries(provider.extensionToLanguage).map(([extension, languageId]) => [normalizeExtension(extension), languageId.trim()] as const);
    if (this.#providers.has(id)) throw new LspError(`LSP provider "${id}" is already registered`, "LSP_INVALID_REQUEST");
    for (const [extension] of extensions) {
      const existing = this.#extensions.get(extension);
      if (existing) throw new LspError(`LSP extension "${extension}" is already registered by "${existing.provider.id}"`, "LSP_INVALID_REQUEST");
    }
    this.#providers.set(id, provider);
    for (const [extension, languageId] of extensions) this.#extensions.set(extension, { provider, languageId });
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.#providers.delete(id);
      for (const [extension] of extensions) {
        if (this.#extensions.get(extension)?.provider === provider) this.#extensions.delete(extension);
      }
      void (provider.dispose?.() ?? Promise.resolve()).catch(() => undefined);
    };
  }

  async query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult> {
    validateQuery(request);
    const rawExtension = extname(request.filePath);
    if (!rawExtension) throw new LspError("No LSP provider is configured for this file type", "LSP_UNAVAILABLE");
    const extension = normalizeExtension(rawExtension);
    const registration = this.#extensions.get(extension);
    if (!registration) throw new LspError(`No LSP provider is configured for "${extension || "this file type"}"`, "LSP_UNAVAILABLE");
    return registration.provider.query({ ...request, languageId: registration.languageId }, signal);
  }

  async dispose(): Promise<void> {
    const providers = [...this.#providers.values()];
    this.#providers.clear();
    this.#extensions.clear();
    await Promise.allSettled(providers.map((provider) => provider.dispose?.()));
  }
}

export interface StdioLspProviderOptions {
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  readonly initializationOptions?: unknown;
  readonly environment?: Readonly<Record<string, string>>;
  readonly maxDocumentBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly killGraceMs?: number;
}

const DEFAULT_MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;

/** A provider backed by a configured local language-server executable speaking LSP over stdio. */
export class StdioLspProvider implements LspProvider {
  readonly id: string;
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  readonly #options: ResolvedStdioLspProviderOptions;
  readonly #instances = new Map<string, LspInstance>();
  readonly #instancePromises = new Map<string, Promise<LspInstance>>();
  #disposed = false;

  constructor(options: StdioLspProviderOptions) {
    validateProviderOptions(options);
    this.id = options.id.trim();
    this.extensionToLanguage = Object.fromEntries(Object.entries(options.extensionToLanguage).map(([extension, language]) => [normalizeExtension(extension), language.trim()]));
    this.#options = {
      ...options,
      command: options.command,
      maxDocumentBytes: options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    };
  }

  async query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.#disposed) throw new LspError(`LSP provider "${this.id}" is disposed`, "LSP_PROCESS");
    const source = await readSource(request.workspaceRoot, request.filePath, this.#options.maxDocumentBytes, signal);
    const key = source.workspacePath;
    let instance = this.#instances.get(key);
    if (!instance || instance.dead) {
      let pending = this.#instancePromises.get(key);
      if (!pending) {
        pending = LspInstance.start(this.#options, source.workspacePath, source.workspaceUri);
        this.#instancePromises.set(key, pending);
        pending.then((created) => {
          this.#instancePromises.delete(key);
          if (this.#disposed) void created.dispose().catch(() => undefined);
          else this.#instances.set(key, created);
        }, () => this.#instancePromises.delete(key));
      }
      try {
        instance = await abortable(pending, signal);
      } catch (error) {
        if (signal?.aborted) void pending.then((created) => created.dispose()).catch(() => undefined);
        throw error;
      }
    }
    try {
      return await instance.query(request, source, signal);
    } catch (error) {
      if (instance.dead || error instanceof LspError && ["LSP_PROCESS", "LSP_PROTOCOL", "LSP_TIMEOUT"].includes(error.code)) {
        this.#instances.delete(key);
        await instance.dispose();
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const instances = [...this.#instances.values()];
    this.#instances.clear();
    await Promise.all(instances.map((instance) => instance.dispose()));
    await Promise.allSettled([...this.#instancePromises.values()]);
  }
}

type ResolvedStdioLspProviderOptions = StdioLspProviderOptions & Required<Pick<StdioLspProviderOptions, "command" | "maxDocumentBytes" | "requestTimeoutMs" | "shutdownTimeoutMs" | "killGraceMs">>;

interface SourceDocument {
  readonly workspacePath: string;
  readonly workspaceUri: string;
  readonly filePath: string;
  readonly fileUri: string;
  readonly text: string;
}

class LspInstance {
  readonly #connection: JsonRpcConnection;
  readonly #options: ResolvedStdioLspProviderOptions;
  readonly #workspaceUri: string;
  readonly #ready: Promise<ServerCapabilities>;
  #queue: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  private constructor(options: ResolvedStdioLspProviderOptions, workspacePath: string, workspaceUri: string, connection: JsonRpcConnection) {
    this.#options = options;
    this.#workspaceUri = workspaceUri;
    this.#connection = connection;
    this.#ready = this.#initialize();
    this.#ready.catch(() => undefined);
  }

  static async start(options: ResolvedStdioLspProviderOptions, workspacePath: string, workspaceUri: string): Promise<LspInstance> {
    const connection = await JsonRpcConnection.start(options.command, options.args ?? [], workspacePath, options.environment);
    const instance = new LspInstance(options, workspacePath, workspaceUri, connection);
    try {
      await instance.#ready;
      return instance;
    } catch (error) {
      await instance.dispose();
      throw error;
    }
  }

  get dead(): boolean { return this.#disposed || this.#connection.closed; }

  query(request: LspProviderQuery, source: SourceDocument, signal?: AbortSignal): Promise<LspQueryResult> {
    const run = abortable(this.#queue, signal).then(() => this.#runQuery(request, source, signal));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #initialize(): Promise<ServerCapabilities> {
    const result = await this.#connection.request("initialize", {
      processId: null,
      rootUri: this.#workspaceUri,
      workspaceFolders: [{ uri: this.#workspaceUri, name: "workspace" }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.#options.initializationOptions ?? null,
    }, this.#options.requestTimeoutMs);
    const capabilities = parseCapabilities(result);
    if (capabilities.positionEncoding && capabilities.positionEncoding !== "utf-16") {
      throw new LspError(`LSP server selected unsupported position encoding "${capabilities.positionEncoding}"`, "LSP_PROTOCOL");
    }
    await this.#connection.notify("initialized", {});
    return capabilities;
  }

  async #runQuery(request: LspProviderQuery, source: SourceDocument, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.#disposed) throw new LspError("LSP instance is disposed", "LSP_PROCESS");
    const capabilities = await abortable(this.#ready, signal);
    if (!supportsOperation(capabilities, request.operation)) throw new LspError(`LSP server does not support ${request.operation}`, "LSP_UNSUPPORTED_OPERATION");
    if (!supportsTransientOpen(capabilities.textDocumentSync)) throw new LspError("LSP server does not support transient document open/close", "LSP_UNSUPPORTED_OPERATION");
    let opened = false;
    try {
      await this.#connection.notify("textDocument/didOpen", { textDocument: { uri: source.fileUri, languageId: request.languageId, version: 1, text: source.text } });
      opened = true;
      const params = {
        textDocument: { uri: source.fileUri },
        position: request.position,
        ...(request.operation === "findReferences" ? { context: { includeDeclaration: true } } : {}),
      };
      const payload = await this.#connection.request(methodFor(request.operation), params, this.#options.requestTimeoutMs, signal);
      return normalizeResult(request.operation, payload, this.#workspaceUri);
    } finally {
      if (opened && !this.dead) await this.#connection.notify("textDocument/didClose", { textDocument: { uri: source.fileUri } }).catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = (async () => {
      try {
        await this.#connection.request("shutdown", null, this.#options.shutdownTimeoutMs);
        await this.#connection.notify("exit", null);
      } catch {
        // Force termination below is authoritative when a server does not complete shutdown.
      }
      await this.#connection.terminate(this.#options.killGraceMs);
    })();
    return this.#disposePromise;
  }
}

interface ServerCapabilities {
  readonly positionEncoding?: string;
  readonly definitionProvider?: unknown;
  readonly referencesProvider?: unknown;
  readonly implementationProvider?: unknown;
  readonly hoverProvider?: unknown;
  readonly textDocumentSync?: unknown;
}

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  workspace: { workspaceFolders: true, configuration: true },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
  },
} as const;

class JsonRpcConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  readonly #closedPromise: Promise<void>;
  #closed = false;
  #nextId = 1;
  #buffer = Buffer.alloc(0);
  #stderr = "";

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.#closedPromise = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        this.#closed = true;
        const detail = this.#stderr.trim() ? `: ${this.#stderr.trim().slice(-1000)}` : "";
        const error = new LspError(`Language server exited${code === null ? ` by ${signal ?? "signal"}` : ` with code ${code}`}${detail}`, "LSP_PROCESS");
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        resolve();
      });
      child.once("error", (error) => {
        this.#closed = true;
        const wrapped = new LspError(`Language server process failed: ${error.message}`, "LSP_PROCESS", { cause: error });
        for (const pending of this.#pending.values()) pending.reject(wrapped);
        this.#pending.clear();
        resolve();
      });
    });
    child.stdout.on("data", (chunk: Buffer | string) => this.#consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderr = `${this.#stderr}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk}`.slice(-4000);
    });
  }

  static async start(command: string, args: readonly string[], cwd: string, environment?: Readonly<Record<string, string>>): Promise<JsonRpcConnection> {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, ...(environment ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const connection = new JsonRpcConnection(child);
    await Promise.race([
      new Promise<void>((resolve) => child.once("spawn", resolve)),
      connection.#closedPromise.then(() => { throw new LspError("Language server exited before startup", "LSP_PROCESS"); }),
    ]);
    return connection;
  }

  get closed(): boolean { return this.#closed; }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new LspError("Language server is not running", "LSP_PROCESS");
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolvePromise, rejectPromise) => this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise }));
    try {
      this.#send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.#pending.delete(id);
      throw new LspError(`Could not send LSP request: ${error instanceof Error ? error.message : String(error)}`, "LSP_PROCESS", { cause: error });
    }
    try {
      return await withTimeout(result, timeoutMs, signal, () => {
        try { this.#send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }); } catch { /* teardown handles a closed transport */ }
      });
    } finally {
      this.#pending.delete(id);
    }
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.#closed) throw new LspError("Language server is not running", "LSP_PROCESS");
    try { this.#send({ jsonrpc: "2.0", method, params }); }
    catch (error) { throw new LspError(`Could not send LSP notification: ${error instanceof Error ? error.message : String(error)}`, "LSP_PROCESS", { cause: error }); }
  }

  async terminate(graceMs: number): Promise<void> {
    if (!this.#closed) {
      try { this.#child.kill(); } catch { /* process may have exited */ }
      await Promise.race([this.#closedPromise, delay(graceMs)]);
    }
    if (!this.#closed && this.#child.pid) {
      if (process.platform === "win32") {
        try { spawn("taskkill", ["/F", "/T", "/PID", String(this.#child.pid)], { stdio: "ignore", windowsHide: true }); } catch { /* best effort */ }
      } else {
        try { this.#child.kill("SIGKILL"); } catch { /* best effort */ }
      }
      await this.#closedPromise;
    }
  }

  #send(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.#child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"), body]));
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const separator = this.#buffer.indexOf(Buffer.from("\r\n\r\n"));
      if (separator < 0) return;
      const header = this.#buffer.subarray(0, separator).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
      if (!lengthMatch) { this.#fail(new LspError("Language server sent a message without Content-Length", "LSP_PROTOCOL")); return; }
      const length = Number(lengthMatch[1]);
      const start = separator + 4;
      if (this.#buffer.length < start + length) return;
      const body = this.#buffer.subarray(start, start + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + length);
      let message: unknown;
      try { message = JSON.parse(body); } catch (error) { this.#fail(new LspError("Language server sent invalid JSON", "LSP_PROTOCOL", { cause: error })); return; }
      this.#handle(message);
    }
  }

  #handle(message: unknown): void {
    if (!isRecord(message)) return;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      if ("error" in message && message.error !== undefined) {
        const error = isRecord(message.error) ? String(message.error.message ?? "Language server request failed") : "Language server request failed";
        pending.reject(new LspError(error, "LSP_PROTOCOL"));
      } else pending.resolve(message.result);
    } else if (typeof message.id === "number" && typeof message.method === "string") {
      // The read-only host only answers configuration/lifecycle requests. LSP servers that ask for
      // edits or commands receive a protocol error instead of gaining a mutation channel.
      const result = message.method === "workspace/configuration" && isRecord(message.params) && Array.isArray(message.params.items)
        ? message.params.items.map(() => null)
        : ["window/workDoneProgress/create", "client/registerCapability", "client/unregisterCapability"].includes(message.method)
          ? null
          : undefined;
      const error = result === undefined ? { code: -32601, message: `Unsupported server request: ${message.method}` } : undefined;
      this.#send({ jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) });
    }
  }

  #fail(error: LspError): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    try { this.#child.kill(); } catch { /* best effort */ }
  }
}

function validateProvider(provider: LspProvider): void {
  validateProviderShape(provider);
  if (typeof provider.query !== "function") throw new LspError(`LSP provider "${provider.id}" has no query implementation`, "LSP_INVALID_REQUEST");
}

function validateProviderShape(provider: { id: string; extensionToLanguage: Readonly<Record<string, string>> }): void {
  if (!provider || typeof provider.id !== "string" || !provider.id.trim()) throw new LspError("LSP provider id must be non-empty", "LSP_INVALID_REQUEST");
  if (!provider.extensionToLanguage || Object.keys(provider.extensionToLanguage).length === 0) throw new LspError(`LSP provider "${provider.id}" has no file extensions`, "LSP_INVALID_REQUEST");
  for (const [extension, language] of Object.entries(provider.extensionToLanguage)) {
    normalizeExtension(extension);
    if (typeof language !== "string" || !language.trim()) throw new LspError(`LSP provider "${provider.id}" has an empty language id`, "LSP_INVALID_REQUEST");
  }
}

function validateProviderOptions(options: StdioLspProviderOptions): void {
  validateProviderShape(options);
  if (!options.command.trim()) throw new LspError("LSP command must be non-empty", "LSP_INVALID_REQUEST");
  if (options.args?.some((arg) => typeof arg !== "string")) throw new LspError("LSP command arguments must be strings", "LSP_INVALID_REQUEST");
  for (const [name, value] of [["maxDocumentBytes", options.maxDocumentBytes], ["requestTimeoutMs", options.requestTimeoutMs], ["shutdownTimeoutMs", options.shutdownTimeoutMs], ["killGraceMs", options.killGraceMs]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new LspError(`LSP ${name} must be a positive integer`, "LSP_INVALID_REQUEST");
  }
}

function validateQuery(request: LspQueryRequest): void {
  if (!request || typeof request.filePath !== "string" || !request.filePath.trim() || typeof request.workspaceRoot !== "string" || !request.workspaceRoot.trim() || !isRecord(request.position)) throw new LspError("LSP filePath, workspaceRoot, and position are required", "LSP_INVALID_REQUEST");
  if (!["goToDefinition", "findReferences", "goToImplementation", "hover"].includes(request.operation)) throw new LspError(`Unsupported LSP operation "${String(request.operation)}"`, "LSP_INVALID_REQUEST");
  if (!Number.isSafeInteger(request.position.line) || request.position.line < 0 || !Number.isSafeInteger(request.position.character) || request.position.character < 0) throw new LspError("LSP position must use non-negative zero-based integers", "LSP_INVALID_REQUEST");
}

function normalizeExtension(extension: string): string {
  const value = extension.trim().toLowerCase();
  if (!value.startsWith(".") || value.length < 2 || value.includes("/") || value.includes("\\")) throw new LspError(`Invalid LSP file extension "${extension}"`, "LSP_INVALID_REQUEST");
  return value;
}

async function readSource(workspaceRoot: string, filePath: string, maxBytes: number, signal?: AbortSignal): Promise<SourceDocument> {
  throwIfAborted(signal);
  let workspacePath: string;
  let sourcePath: string;
  try {
    workspacePath = await realpath(resolve(workspaceRoot));
    sourcePath = await realpath(resolve(workspacePath, filePath));
  } catch (error) {
    throw new LspError(`LSP source could not be resolved: ${error instanceof Error ? error.message : String(error)}`, "LSP_SOURCE_INVALID", { cause: error });
  }
  const boundary = relative(workspacePath, sourcePath);
  if (boundary === ".." || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)) throw new LspError(`LSP source "${filePath}" is outside the workspace`, "LSP_SOURCE_INVALID");
  const [workspaceInfo, sourceInfo] = await Promise.all([stat(workspacePath), stat(sourcePath)]);
  if (!workspaceInfo.isDirectory() || !sourceInfo.isFile()) throw new LspError(`LSP source "${filePath}" is not a regular file in a workspace`, "LSP_SOURCE_INVALID");
  if (sourceInfo.size > maxBytes) throw new LspError(`LSP source "${filePath}" exceeds the ${maxBytes}-byte limit`, "LSP_SOURCE_TOO_LARGE");
  throwIfAborted(signal);
  const text = await readFile(sourcePath, "utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new LspError(`LSP source "${filePath}" exceeds the ${maxBytes}-byte limit`, "LSP_SOURCE_TOO_LARGE");
  return { workspacePath, workspaceUri: pathToFileURL(workspacePath).href, filePath: sourcePath, fileUri: pathToFileURL(sourcePath).href, text };
}

function methodFor(operation: LspOperation): string {
  switch (operation) {
    case "goToDefinition": return "textDocument/definition";
    case "findReferences": return "textDocument/references";
    case "goToImplementation": return "textDocument/implementation";
    case "hover": return "textDocument/hover";
  }
}

function supportsOperation(capabilities: ServerCapabilities, operation: LspOperation): boolean {
  switch (operation) {
    case "goToDefinition": return capabilityEnabled(capabilities.definitionProvider);
    case "findReferences": return capabilityEnabled(capabilities.referencesProvider);
    case "goToImplementation": return capabilityEnabled(capabilities.implementationProvider);
    case "hover": return capabilityEnabled(capabilities.hoverProvider);
  }
}

function capabilityEnabled(value: unknown): boolean { return value === true || isRecord(value); }

function supportsTransientOpen(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return value === 1 || value === 2;
  return isRecord(value) && value.openClose === true;
}

function parseCapabilities(value: unknown): ServerCapabilities {
  if (!isRecord(value) || !isRecord(value.capabilities)) throw new LspError("LSP initialize response did not include capabilities", "LSP_PROTOCOL");
  return value.capabilities as ServerCapabilities;
}

function normalizeResult(operation: LspOperation, payload: unknown, workspaceUri: string): LspQueryResult {
  if (operation === "hover") return { kind: "hover", hover: normalizeHover(payload) };
  const values = payload === null ? [] : Array.isArray(payload) ? payload : [payload];
  const locations: LspLocation[] = [];
  for (const value of values) {
    if (!isRecord(value)) throw new LspError("LSP navigation response contained an invalid location", "LSP_PROTOCOL");
    const uri = typeof value.uri === "string" ? value.uri : typeof value.targetUri === "string" ? value.targetUri : undefined;
    // Definition/implementation requests may return either Location or LocationLink.
    // LocationLink carries both targetRange and targetSelectionRange; prefer the
    // selection range for the cursor target and fall back to the full target range.
    const rangeValue = value.range ?? value.targetSelectionRange ?? value.targetRange;
    if (!uri || !isRange(rangeValue)) throw new LspError("LSP navigation response contained an invalid location", "LSP_PROTOCOL");
    locations.push({ uri, range: rangeValue });
  }
  return { kind: "locations", locations, resolvedWorkspaceUri: workspaceUri };
}

function normalizeHover(payload: unknown): LspHover | null {
  if (payload === null) return null;
  if (!isRecord(payload)) throw new LspError("LSP hover response was invalid", "LSP_PROTOCOL");
  const contents = renderHoverContents(payload.contents);
  if (!contents) return null;
  if (payload.range !== undefined && !isRange(payload.range)) throw new LspError("LSP hover response contained an invalid range", "LSP_PROTOCOL");
  return { contents, ...(payload.range ? { range: payload.range } : {}) };
}

function renderHoverContents(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => renderHoverContents(entry)).filter(Boolean).join("\n\n");
  if (isRecord(value) && typeof value.language === "string" && typeof value.value === "string") return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  if (isRecord(value) && typeof value.value === "string") return value.value;
  throw new LspError("LSP hover response contained invalid content", "LSP_PROTOCOL");
}

function isRange(value: unknown): value is LspRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function isPosition(value: unknown): value is LspPosition {
  return isRecord(value) && Number.isSafeInteger(value.line) && Number(value.line) >= 0 && Number.isSafeInteger(value.character) && Number(value.character) >= 0;
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new LspError("LSP request was cancelled", "LSP_TIMEOUT"); }

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(new LspError("LSP request was cancelled", "LSP_TIMEOUT"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolvePromise(value); }, (error) => { signal.removeEventListener("abort", onAbort); rejectPromise(error); });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_, rejectPromise) => {
    timer = setTimeout(() => { onTimeout(); rejectPromise(new LspError(`LSP request timed out after ${timeoutMs}ms`, "LSP_TIMEOUT")); }, timeoutMs);
  });
  const cancelled = signal ? new Promise<never>((_, rejectPromise) => {
    abortListener = () => { onTimeout(); rejectPromise(new LspError("LSP request was cancelled", "LSP_TIMEOUT")); };
    signal.addEventListener("abort", abortListener, { once: true });
  }) : undefined;
  try { return await Promise.race([promise, timeout, ...(cancelled ? [cancelled] : [])]); }
  finally { if (timer) clearTimeout(timer); if (signal && abortListener) signal.removeEventListener("abort", abortListener); }
}

function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

export function formatLspResult(result: LspQueryResult, workspacePath: string, maxLocations = 100, maxChars = 16_000): string {
  const lines: string[] = [];
  if (result.kind === "hover") {
    if (!result.hover) return "No hover information.";
    lines.push(result.hover.contents);
    if (result.hover.range) lines.push(`\nRange: ${formatRange(result.hover.range)}`);
  } else if (result.locations.length === 0) {
    return "No results.";
  } else {
    lines.push(...result.locations.slice(0, maxLocations).map((location) => `${formatUri(location.uri, workspacePath)}:${location.range.start.line + 1}:${location.range.start.character + 1} (${formatRange(location.range)})`));
    if (result.locations.length > maxLocations) lines.push(`[${result.locations.length - maxLocations} more results omitted]`);
  }
  return truncateText(lines.join("\n"), maxChars);
}

function formatUri(uri: string, workspacePath: string): string {
  try {
    const path = fileURLToPath(uri);
    const relativePath = relative(workspacePath, path);
    return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath.split(sep).join("/") : path;
  } catch { return uri; }
}

function formatRange(range: LspRange): string { return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`; }
function truncateText(text: string, maxChars: number): string { return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 80))}\n[truncated at ${maxChars} characters]`; }
