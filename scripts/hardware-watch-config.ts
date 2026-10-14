import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WATCH_CENTER, WATCH_RADIUS_KM } from "./hardware-watch-filter.js";

export type WatchQueryConfig = {
  kind: "mac" | "proxmox";
  query: string;
  limit: number;
  maxPages: number;
  minPrice: number | null;
  maxPrice: number | null;
};

export type WatchConfig = {
  center: { latitude: number; longitude: number };
  radiusKm: number;
  queries: WatchQueryConfig[];
  targets: {
    macStudio: string;
    proxmox: string;
  };
};

export type PendingConfig = WatchConfig & {
  savedAt: string;
  status: "pending" | "applied";
};

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  center: WATCH_CENTER,
  radiusKm: WATCH_RADIUS_KM,
  queries: [
    ["mac", "Mac Studio Max"], ["mac", "Mac Studio M2 Max"], ["mac", "Mac Studio Ultra"], ["mac", "Mac Studio M2 Ultra"],
    ["proxmox", "i7-12700 workstation"], ["proxmox", "OptiPlex 7000 Tower i7-12700"], ["proxmox", "ThinkStation P360 Tower"],
    ["proxmox", "HP Z2 G9 Tower"], ["proxmox", "128GB DDR4 RAM"], ["proxmox", "512GB NVMe SSD"], ["proxmox", "CPU motherboard RAM combo"],
  ].map(([kind, query]) => ({ kind: kind as "mac" | "proxmox", query, limit: 10, maxPages: 1, minPrice: null, maxPrice: null })),
  targets: {
    macStudio: "M2 Max, 96 GB unified memory, 38-core GPU; preferably 1 TB SSD; $1,500–$1,700 ideal and up to $1,900 all-in is strong.",
    proxmox: "$1,000 all-in build target; 128 GB RAM; compatible modern x86 platform, storage, and any required GPU remain evidence-dependent.",
  },
};

export const PENDING_FILENAME = "pending-configuration.json";
export const ACTIVE_FILENAME = "active-configuration.json";
export const BACKUP_FILENAME = "active-configuration.backup.json";

export function configPaths(outputRoot: string) {
  return {
    pending: join(outputRoot, PENDING_FILENAME),
    active: join(outputRoot, ACTIVE_FILENAME),
    backup: join(outputRoot, BACKUP_FILENAME),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateWatchConfig(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["Configuration must be an object."];
  const config = value as Partial<WatchConfig>;
  if (!config.center || !isFiniteNumber(config.center.latitude) || !isFiniteNumber(config.center.longitude)) errors.push("Search center must have numeric latitude and longitude.");
  if (config.center && (config.center.latitude < -90 || config.center.latitude > 90 || config.center.longitude < -180 || config.center.longitude > 180)) errors.push("Search center coordinates are out of range.");
  if (!isFiniteNumber(config.radiusKm) || config.radiusKm <= 0 || config.radiusKm > 500) errors.push("Radius must be greater than 0 and no more than 500 km.");
  if (!Array.isArray(config.queries) || config.queries.length === 0) errors.push("At least one search query is required.");
  const seen = new Set<string>();
  for (const [index, query] of (config.queries ?? []).entries()) {
    if (!query || typeof query !== "object") { errors.push(`Query ${index + 1} is invalid.`); continue; }
    if (query.kind !== "mac" && query.kind !== "proxmox") errors.push(`Query ${index + 1} must be Mac Studio or Proxmox.`);
    if (typeof query.query !== "string" || !query.query.trim()) errors.push(`Query ${index + 1} must have text.`);
    const key = `${query.kind}:${String(query.query ?? "").trim().toLowerCase()}`;
    if (seen.has(key)) errors.push(`Duplicate query: ${query.kind} / ${query.query}.`);
    seen.add(key);
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) errors.push(`Query ${index + 1} result limit must be an integer from 1 to 50.`);
    if (!Number.isInteger(query.maxPages) || query.maxPages < 1 || query.maxPages > 3) errors.push(`Query ${index + 1} page count must be an integer from 1 to 3.`);
    for (const field of ["minPrice", "maxPrice"] as const) if (query[field] !== null && (!isFiniteNumber(query[field]) || query[field] < 0)) errors.push(`Query ${index + 1} ${field} must be empty or a nonnegative number; 0 is valid.`);
    if (query.minPrice !== null && query.maxPrice !== null && query.minPrice > query.maxPrice) errors.push(`Query ${index + 1} minimum price cannot exceed maximum price.`);
  }
  return errors;
}

export function normalizeWatchConfig(value: unknown): WatchConfig {
  const input = value as Partial<WatchConfig>;
  return {
    center: { latitude: input.center?.latitude ?? DEFAULT_WATCH_CONFIG.center.latitude, longitude: input.center?.longitude ?? DEFAULT_WATCH_CONFIG.center.longitude },
    radiusKm: input.radiusKm ?? DEFAULT_WATCH_CONFIG.radiusKm,
    queries: (input.queries ?? DEFAULT_WATCH_CONFIG.queries).map((query) => ({
      kind: query.kind,
      query: query.query,
      limit: query.limit ?? 10,
      maxPages: query.maxPages ?? 1,
      minPrice: query.minPrice ?? null,
      maxPrice: query.maxPrice ?? null,
    })),
    targets: { macStudio: input.targets?.macStudio ?? DEFAULT_WATCH_CONFIG.targets.macStudio, proxmox: input.targets?.proxmox ?? DEFAULT_WATCH_CONFIG.targets.proxmox },
  };
}

export function diffWatchConfig(active: WatchConfig, proposed: WatchConfig): string[] {
  const changes: string[] = [];
  if (active.center.latitude !== proposed.center.latitude || active.center.longitude !== proposed.center.longitude) changes.push(`Center: ${active.center.latitude}, ${active.center.longitude} → ${proposed.center.latitude}, ${proposed.center.longitude}`);
  if (active.radiusKm !== proposed.radiusKm) changes.push(`Radius: ${active.radiusKm} km → ${proposed.radiusKm} km`);
  const activeKeys = active.queries.map((query) => `${query.kind}:${query.query}`);
  const proposedKeys = proposed.queries.map((query) => `${query.kind}:${query.query}`);
  for (const key of activeKeys.filter((key) => !proposedKeys.includes(key))) changes.push(`Removed query: ${key}`);
  for (const key of proposedKeys.filter((key) => !activeKeys.includes(key))) changes.push(`Added query: ${key}`);
  proposed.queries.forEach((query, index) => {
    const old = active.queries.find((candidate) => candidate.kind === query.kind && candidate.query === query.query);
    if (!old) return;
    if (old.limit !== query.limit) changes.push(`${query.query}: limit ${old.limit} → ${query.limit}`);
    if (old.maxPages !== query.maxPages) changes.push(`${query.query}: pages ${old.maxPages} → ${query.maxPages}`);
    if (old.minPrice !== query.minPrice) changes.push(`${query.query}: min price ${old.minPrice ?? "none"} → ${query.minPrice ?? "none"}`);
    if (old.maxPrice !== query.maxPrice) changes.push(`${query.query}: max price ${old.maxPrice ?? "none"} → ${query.maxPrice ?? "none"}`);
    if (activeKeys.indexOf(`${query.kind}:${query.query}`) !== index) changes.push(`Reordered query: ${query.query}`);
  });
  return changes.length ? changes : ["No changes from the active watcher configuration."];
}

async function readJson(path: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

export async function loadActiveWatchConfig(outputRoot: string): Promise<WatchConfig> {
  const value = await readJson(configPaths(outputRoot).active);
  if (!value || validateWatchConfig(value).length) return DEFAULT_WATCH_CONFIG;
  return normalizeWatchConfig(value);
}

export async function loadConfigurationState(outputRoot: string) {
  const paths = configPaths(outputRoot);
  const active = await loadActiveWatchConfig(outputRoot);
  const pendingValue = await readJson(paths.pending);
  const pending = pendingValue && (pendingValue as { status?: string }).status !== "applied" && validateWatchConfig(pendingValue).length === 0 ? normalizeWatchConfig(pendingValue) : null;
  return { active, pending, diff: pending ? diffWatchConfig(active, pending) : ["No pending configuration saved."], hasBackup: Boolean(await readJson(paths.backup)) };
}

export async function savePendingConfiguration(outputRoot: string, value: unknown): Promise<{ pending: WatchConfig; diff: string[] }> {
  const errors = validateWatchConfig(value);
  if (errors.length) throw new Error(errors.join(" "));
  const pending = normalizeWatchConfig(value);
  await writeFile(configPaths(outputRoot).pending, `${JSON.stringify({ ...pending, savedAt: new Date().toISOString(), status: "pending" }, null, 2)}\n`, "utf8");
  return { pending, diff: diffWatchConfig(await loadActiveWatchConfig(outputRoot), pending) };
}

export async function discardPendingConfiguration(outputRoot: string, confirmation: unknown) {
  if (confirmation !== "DISCARD_PENDING") throw new Error("Explicit confirmation is required to discard the pending configuration.");
  try {
    await unlink(configPaths(outputRoot).pending);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return loadConfigurationState(outputRoot);
}

export async function applyPendingConfiguration(outputRoot: string, confirmation: unknown) {
  if (confirmation !== "APPLY_NEXT_RUN") throw new Error("Explicit confirmation is required to apply the next-run configuration.");
  const paths = configPaths(outputRoot);
  const state = await loadConfigurationState(outputRoot);
  if (!state.pending) throw new Error("No valid pending configuration is available.");
  await writeFile(paths.backup, `${JSON.stringify({ ...state.active, backedUpAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  await writeFile(paths.active, `${JSON.stringify(state.pending, null, 2)}\n`, "utf8");
  await writeFile(paths.pending, `${JSON.stringify({ ...state.pending, savedAt: new Date().toISOString(), status: "applied" }, null, 2)}\n`, "utf8");
  return loadConfigurationState(outputRoot);
}

export async function revertLastAppliedConfiguration(outputRoot: string, confirmation: unknown) {
  if (confirmation !== "REVERT_LAST_APPLIED") throw new Error("Explicit confirmation is required to revert the last applied configuration.");
  const paths = configPaths(outputRoot);
  const backup = await readJson(paths.backup);
  if (!backup) throw new Error("No configuration backup is available.");
  const restored = normalizeWatchConfig(backup);
  const errors = validateWatchConfig(restored);
  if (errors.length) throw new Error("The configuration backup is invalid.");
  await writeFile(paths.active, `${JSON.stringify(restored, null, 2)}\n`, "utf8");
  return loadConfigurationState(outputRoot);
}

export function estimateRateLimitWaitMs(config: WatchConfig): number {
  const requests = config.queries.reduce((total, query) => total + query.maxPages, 0);
  if (requests <= 1) return 0;
  return (requests - 1) * 1_250 + Math.floor((requests - 1) / 3) * 60_000;
}

export function rateLimitSummary(config: WatchConfig): string {
  const requests = config.queries.reduce((total, query) => total + query.maxPages, 0);
  const wait = estimateRateLimitWaitMs(config);
  return `${requests} planned Marketplace requests; approximately ${(wait / 1000).toFixed(1)} seconds of limiter wait (3 requests/minute, 0.5–2 seconds jitter between requests; estimate only).`;
}
