import { mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_FREE_FINDS_CONFIG, freeFindsConfigPath, normalizeFreeFindsConfig, validateFreeFindsConfig, type FreeFindsConfig, type FreeFindsQuery } from "./free-finds-config.js";
import { DEFAULT_MAX_REQUESTS_PER_MINUTE } from "../src/utils/rate-limit.js";

export const FREE_FINDS_REQUEST_TIMEOUT_MS = 20_000;
export const FREE_FINDS_RUN_TIMEOUT_MS = 10 * 60_000;
export const FREE_FINDS_SHUTDOWN_TIMEOUT_MS = 3_000;
export const FREE_FINDS_LOCK_FILENAME = "free-finds-run.lock";

export type FreeFindsClient = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools?: unknown[] }>;
  callTool(args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
};
export type FreeFindsTransport = {
  pid?: number | null;
  start?(): Promise<void>;
  close(): Promise<void>;
};
export type FreeFindsMcpFactory = () => { client: FreeFindsClient; transport: FreeFindsTransport };

export type FreeFindsRunReceipt = {
  mode: "free_finds";
  runAt: string;
  startedAt: string;
  endedAt: string;
  status: "complete" | "partial" | "failed" | "blocked";
  readOnly: true;
  monitorsCreated: false;
  comparisonSource: string | null;
  previousRunAt: string | null;
  configuration: FreeFindsConfig | null;
  center: FreeFindsConfig["center"] | null;
  radiusKm: number | null;
  queries: Array<{ query: string; limit: number; maxPages: number; count: number; pages: number; error?: string }>;
  rawListings: Record<string, any>[];
  deduplicatedListingCount: number;
  errors: Array<{ stage: string; query?: string; error: string }>;
  receipt: { startedAt: string; endedAt: string; queryCount: number; pageCount: number; errorCount: number; comparisonSource: string | null };
};

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const defaultRoot = resolve(process.env.FREE_FINDS_OUTPUT_DIR ?? resolve(repoRoot, ".local/hardware-watch"));
const progressDefault = (message: string) => process.stderr.write(`[free-finds] ${message}\n`);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolvePromise, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out during ${stage} after ${timeoutMs} ms`)), timeoutMs);
    promise.then(resolvePromise, reject).finally(() => { if (timer) clearTimeout(timer); });
  });
}

async function closeQuietly(client: FreeFindsClient | null, transport: FreeFindsTransport | null, progress: (message: string) => void): Promise<void> {
  if (client) try { await withTimeout(client.close(), FREE_FINDS_SHUTDOWN_TIMEOUT_MS, "Free Finds client shutdown"); } catch (error) { progress(`shutdown: client ${error instanceof Error ? error.message : String(error)}`); }
  if (transport) try { await withTimeout(transport.close(), FREE_FINDS_SHUTDOWN_TIMEOUT_MS, "Free Finds transport shutdown"); } catch (error) { progress(`shutdown: transport ${error instanceof Error ? error.message : String(error)}`); }
}

async function acquireLock(root: string): Promise<() => Promise<void>> {
  const lockPath = resolve(root, FREE_FINDS_LOCK_FILENAME);
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A Free Finds run is already in progress; concurrency guard blocked this run.");
    throw error;
  }
  return async () => { try { await unlink(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
}

function parseOutput(response: any): Record<string, any>[] {
  if (Array.isArray(response?.structuredContent?.listings)) return response.structuredContent.listings;
  const text = response?.content?.find((part: any) => part.type === "text")?.text;
  if (!text) return [];
  try { const parsed = JSON.parse(text); return Array.isArray(parsed?.listings) ? parsed.listings : []; } catch { return []; }
}

function defaultMcpFactory(): { client: FreeFindsClient; transport: FreeFindsTransport } {
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(repoRoot, "dist/index.js")], cwd: repoRoot, stderr: "pipe" });
  const client = new Client({ name: "free-finds-runner", version: "1.0.0" });
  return { client, transport };
}

async function previousComparison(root: string): Promise<{ name: string; runAt: string } | null> {
  try {
    const names = (await readdir(root)).filter((name) => name.startsWith("free-finds-report-") && name.endsWith(".json"));
    const reports: Array<{ name: string; runAt: number; runAtText: string }> = [];
    for (const name of names) {
      try { const data = JSON.parse(await readFile(resolve(root, name), "utf8")); if (typeof data.runAt === "string") reports.push({ name, runAt: Date.parse(data.runAt) || 0, runAtText: data.runAt }); } catch { /* malformed history is not a comparison source */ }
    }
    reports.sort((a, b) => b.runAt - a.runAt);
    return reports[0] ? { name: reports[0].name, runAt: reports[0].runAtText } : null;
  } catch { return null; }
}

async function loadExecutionConfig(root: string): Promise<{ config: FreeFindsConfig; errors: string[] }> {
  try {
    const raw = JSON.parse(await readFile(freeFindsConfigPath(root), "utf8")) as unknown;
    const errors = validateFreeFindsConfig(raw);
    return { config: normalizeFreeFindsConfig(raw), errors };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULT_FREE_FINDS_CONFIG, errors: [] };
    return { config: DEFAULT_FREE_FINDS_CONFIG, errors: [`Free Finds configuration could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function queryArguments(config: FreeFindsConfig, query: FreeFindsQuery): Record<string, unknown> {
  return {
    query: query.query,
    latitude: config.center.latitude,
    longitude: config.center.longitude,
    radius_km: query.radiusKm ?? config.radiusKm,
    limit: query.limit,
    max_pages: query.maxPages,
    max_price: 0,
    response_format: "json",
  };
}

function emptyReceipt(startedAt: string, endedAt: string, configuration: FreeFindsConfig | null, comparisonSource: string | null, previousRunAt: string | null, status: FreeFindsRunReceipt["status"], errors: FreeFindsRunReceipt["errors"]): FreeFindsRunReceipt {
  return { mode: "free_finds", runAt: endedAt, startedAt, endedAt, status, readOnly: true, monitorsCreated: false, comparisonSource, previousRunAt, configuration, center: configuration?.center ?? null, radiusKm: configuration?.radiusKm ?? null, queries: [], rawListings: [], deduplicatedListingCount: 0, errors, receipt: { startedAt, endedAt, queryCount: 0, pageCount: 0, errorCount: errors.length, comparisonSource } };
}

export async function runFreeFinds(options: {
  root: string;
  client?: FreeFindsClient;
  transport?: FreeFindsTransport;
  factory?: FreeFindsMcpFactory;
  progress?: (message: string) => void;
  requestTimeoutMs?: number;
  runTimeoutMs?: number;
  now?: () => Date;
}): Promise<FreeFindsRunReceipt> {
  const progress = options.progress ?? progressDefault;
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  await mkdir(options.root, { recursive: true });
  const release = await acquireLock(options.root);
  let configuration: FreeFindsConfig | null = null;
  let client: FreeFindsClient | null = null;
  let transport: FreeFindsTransport | null = null;
  const errors: FreeFindsRunReceipt["errors"] = [];
  const rawById = new Map<string, Record<string, any>>();
  const queryReceipts: FreeFindsRunReceipt["queries"] = [];
  const comparison = await previousComparison(options.root);
  const comparisonSource = comparison?.name ?? null;
  const previousRunAt = comparison?.runAt ?? null;
  try {
    const loaded = await loadExecutionConfig(options.root);
    configuration = loaded.config;
    const validationErrors = loaded.errors;
    if (validationErrors.length) {
      errors.push(...validationErrors.map((error) => ({ stage: "configuration", error })));
      const endedAt = now().toISOString();
      const receipt = emptyReceipt(startedAt, endedAt, configuration, comparisonSource, previousRunAt, "blocked", errors);
      await writeFreeFindsReport(options.root, receipt);
      return receipt;
    }
    const mcp = options.client && options.transport ? { client: options.client, transport: options.transport } : (options.factory ?? defaultMcpFactory)();
    client = mcp.client; transport = mcp.transport;
    progress("startup: Free Finds MCP child");
    await withTimeout(client.connect(transport), options.requestTimeoutMs ?? FREE_FINDS_REQUEST_TIMEOUT_MS, "Free Finds MCP initialize");
    await withTimeout(client.listTools(), options.requestTimeoutMs ?? FREE_FINDS_REQUEST_TIMEOUT_MS, "Free Finds tool discovery");
    const operation = (async () => {
      for (const query of configuration!.queries) {
        const receipt = { query: query.query, limit: query.limit, maxPages: query.maxPages, count: 0, pages: 0 } as FreeFindsRunReceipt["queries"][number];
        try {
          progress(`search start: ${query.query}`);
          const response = await withTimeout(client!.callTool({ name: "facebook_marketplace_search_listings", arguments: queryArguments(configuration!, query) }), options.requestTimeoutMs ?? FREE_FINDS_REQUEST_TIMEOUT_MS, `Free Finds search ${query.query}`);
          const listings = parseOutput(response);
          receipt.count = listings.length; receipt.pages = query.maxPages;
          for (const listing of listings) {
            if (!listing || typeof listing.id !== "string") continue;
            const existing = rawById.get(listing.id);
            rawById.set(listing.id, existing ? { ...existing, queries: [...new Set([...(existing.queries ?? []), query.query])] } : { ...listing, query: query.query, queries: [query.query] });
          }
          progress(`search end: ${query.query} (${receipt.count} listings)`);
        } catch (error) {
          receipt.error = error instanceof Error ? error.message : String(error);
          errors.push({ stage: "search", query: query.query, error: receipt.error });
          progress(`search error: ${query.query}: ${receipt.error}`);
        }
        queryReceipts.push(receipt);
      }
    })();
    try { await withTimeout(operation, options.runTimeoutMs ?? FREE_FINDS_RUN_TIMEOUT_MS, "Free Finds whole run"); }
    catch (error) { errors.push({ stage: "run", error: error instanceof Error ? error.message : String(error) }); operation.catch(() => undefined); }
  } catch (error) {
    errors.push({ stage: "startup", error: error instanceof Error ? error.message : String(error) });
  } finally {
    await closeQuietly(client, transport, progress);
    await release();
  }
  const endedAt = now().toISOString();
  const status: FreeFindsRunReceipt["status"] = errors.length === 0 ? "complete" : rawById.size > 0 || queryReceipts.length > 0 ? "partial" : "failed";
  const receipt: FreeFindsRunReceipt = { mode: "free_finds", runAt: endedAt, startedAt, endedAt, status, readOnly: true, monitorsCreated: false, comparisonSource, previousRunAt, configuration, center: configuration?.center ?? null, radiusKm: configuration?.radiusKm ?? null, queries: queryReceipts, rawListings: [...rawById.values()], deduplicatedListingCount: rawById.size, errors, receipt: { startedAt, endedAt, queryCount: queryReceipts.length, pageCount: queryReceipts.reduce((total, query) => total + query.pages, 0), errorCount: errors.length, comparisonSource } };
  await writeFreeFindsReport(options.root, receipt);
  return receipt;
}

async function writeFreeFindsReport(root: string, receipt: FreeFindsRunReceipt): Promise<void> {
  const stamp = receipt.endedAt.replace(/[:.]/g, "-");
  await writeFile(resolve(root, `free-finds-report-${stamp}.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFreeFinds({ root: defaultRoot }).then((receipt) => { console.log(JSON.stringify(receipt.receipt, null, 2)); process.exitCode = receipt.status === "complete" ? 0 : 1; }).catch((error) => { console.error(`[free-finds] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
