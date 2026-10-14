export type WatchProgress = (message: string) => void;

export type WatchMcpTransport = {
  pid?: number | null;
  start?(): Promise<void>;
  close(): Promise<void>;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
};

export type WatchMcpClient = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools?: unknown[] }>;
  callTool(args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
};

export type WatchSearch = { kind: string; query: string; limit?: number; maxPages?: number; minPrice?: number | null; maxPrice?: number | null };

export type WatchSearchRun = {
  results: Array<{ kind: string; query: string; count: number; error?: string }>;
  errors: Array<{ kind: string; query: string; error: string }>;
};

export const STARTUP_TIMEOUT_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 20_000;
export const RATE_LIMIT_QUEUE_TIMEOUT_MS = 65_000;
export const SHUTDOWN_TIMEOUT_MS = 3_000;

export class WatchStageTimeout extends Error {
  constructor(public readonly stage: string, timeoutMs: number) {
    super(`Timed out during ${stage} after ${timeoutMs} ms`);
    this.name = "WatchStageTimeout";
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new WatchStageTimeout(stage, timeoutMs)), timeoutMs);
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

async function closeQuietly(client: WatchMcpClient, transport: WatchMcpTransport, progress: WatchProgress): Promise<void> {
  progress("shutdown: stopping MCP child");
  try {
    await withTimeout(client.close(), SHUTDOWN_TIMEOUT_MS, "MCP child shutdown");
  } catch (error) {
    progress(`shutdown: client close ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await withTimeout(transport.close(), SHUTDOWN_TIMEOUT_MS, "MCP transport shutdown");
  } catch (error) {
    progress(`shutdown: transport close ${error instanceof Error ? error.message : String(error)}`);
  }
  progress("shutdown: complete");
}

type CallTiming = { queueWaitMs: number; networkMs: number; queueActive: boolean; queueObserved: boolean };

function attachTimingLogs(transport: WatchMcpTransport, progress: WatchProgress): {
  current: CallTiming;
  reset(): void;
} {
  const current: CallTiming = { queueWaitMs: 0, networkMs: 0, queueActive: false, queueObserved: false };
  let buffer = "";
  const handle = (chunk: Buffer | string) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.includes("rate-limit queue wait start")) {
        current.queueObserved = true;
        current.queueActive = true;
        progress("rate-limit queue wait: started");
      }
      const queue = line.match(/rate-limit queue wait: (\d+)ms/);
      if (queue) {
        current.queueObserved = true;
        current.queueActive = false;
        current.queueWaitMs += Number(queue[1]);
        progress(`rate-limit queue wait: ${queue[1]}ms`);
      }
      const network = line.match(/network\/search duration: (\d+)ms/);
      if (network) {
        current.networkMs += Number(network[1]);
        progress(`network/search duration: ${network[1]}ms`);
      }
    }
  };
  transport.stderr?.on("data", handle);
  return {
    current,
    reset() {
      current.queueWaitMs = 0;
      current.networkMs = 0;
      current.queueActive = false;
      current.queueObserved = false;
    },
  };
}

export async function runMcpSearches(options: {
  client: WatchMcpClient;
  transport: WatchMcpTransport;
  searches: readonly WatchSearch[];
  callArguments: (search: WatchSearch) => Record<string, unknown>;
  parseCount: (response: unknown) => number;
  onResponse?: (search: WatchSearch, response: unknown) => void | Promise<void>;
  progress?: WatchProgress;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  queueTimeoutMs?: number;
}): Promise<WatchSearchRun> {
  const progress = options.progress ?? (() => undefined);
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const queueTimeoutMs = options.queueTimeoutMs ?? RATE_LIMIT_QUEUE_TIMEOUT_MS;
  const results: WatchSearchRun["results"] = [];
  const errors: WatchSearchRun["errors"] = [];
  let completed = false;

  try {
    progress("mcp child spawn: starting");
    progress("mcp initialize: starting");
    let childSpawned = false;
    const clientTransport = new Proxy(options.transport, {
      get(target, property, receiver) {
        if (property === "start") {
          return async () => {
            if (childSpawned) return;
            if (target.start) await withTimeout(target.start(), startupTimeoutMs, "MCP child spawn");
            childSpawned = true;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await withTimeout(options.client.connect(clientTransport), startupTimeoutMs, "MCP initialize");
    const timing = attachTimingLogs(options.transport, progress);
    progress(`mcp initialize: complete${options.transport.pid ? ` (pid ${options.transport.pid})` : ""}`);

    progress("tool discovery: starting");
    const discovered = await withTimeout(options.client.listTools(), requestTimeoutMs, "tool discovery");
    progress(`tool discovery: complete (${discovered.tools?.length ?? 0} tools)`);

    for (const [index, search] of options.searches.entries()) {
      progress(`search ${index + 1}/${options.searches.length} start: ${search.query}`);
      timing.reset();
      const toolStartedAt = Date.now();
      try {
        const response = await withTimeout(
          options.client.callTool(options.callArguments(search)),
          queueTimeoutMs + requestTimeoutMs,
          "MCP search including rate-limit queue",
        );
        await options.onResponse?.(search, response);
        const count = options.parseCount(response);
        results.push({ kind: search.kind, query: search.query, count });
        progress(`tool-call duration: ${Date.now() - toolStartedAt}ms; rate-limit queue wait: ${timing.current.queueWaitMs}ms; network/search duration: ${timing.current.networkMs}ms`);
        progress(`search ${index + 1}/${options.searches.length} end: ${search.query} (${count} listings)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof WatchStageTimeout) {
          const stage = timing.current.queueActive || (timing.current.queueObserved && timing.current.networkMs === 0)
            ? `MCP rate-limit queue for "${search.query}"`
            : `Marketplace search "${search.query}" after rate-limit slot`;
          progress(`tool-call duration: ${Date.now() - toolStartedAt}ms; rate-limit queue wait: ${timing.current.queueWaitMs}ms; network/search duration: ${timing.current.networkMs}ms`);
          throw new WatchStageTimeout(stage, error.message.match(/after (\d+) ms/) ? Number(error.message.match(/after (\d+) ms/)![1]) : queueTimeoutMs + requestTimeoutMs);
        }
        errors.push({ kind: search.kind, query: search.query, error: message });
        results.push({ kind: search.kind, query: search.query, count: 0, error: message });
        progress(`search ${index + 1}/${options.searches.length} error: ${search.query}`);
      }
    }
    completed = true;
    return { results, errors };
  } finally {
    await closeQuietly(options.client, options.transport, progress);
    if (!completed) progress("MCP search run: incomplete");
  }
}
