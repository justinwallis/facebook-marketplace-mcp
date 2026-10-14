import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_REQUESTS_PER_MINUTE, estimateRateLimitWaitRange } from "../src/utils/rate-limit.js";

export type FreeFindsQuery = {
  query: string;
  limit: number;
  maxPages: number;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  maxPrice?: 0;
};
export type FreeFindsConfig = {
  center: { latitude: number; longitude: number };
  radiusKm: number;
  queries: FreeFindsQuery[];
  maxPrice: 0;
  mode: "configuration_only";
  cadence?: "manual_review_only";
};
export type FreeFindsReadinessPreview = {
  ready: boolean;
  errors: string[];
  warnings: string[];
  requestCount: number;
  resultSlots: number;
  durationMs: { min: number; max: number };
  maxRequestsPerMinute: number;
  center: { latitude: number; longitude: number } | null;
  radiusKm: number | null;
  queries: Array<{ query: string; resultLimit: number | null; pages: number | null; resultSlots: number; requests: number; radiusKm: number | null; maxPrice: 0 | null; enabled: boolean; errors: string[] }>;
  summary: string;
};

export const FREE_FINDS_CONFIG_FILENAME = "free-finds-configuration.json";
export const FREE_FINDS_CENTER = { latitude: 39.56, longitude: -76.25 };
export const FREE_FINDS_RADIUS_KM = 80;
export const DEFAULT_FREE_FINDS_CONFIG: FreeFindsConfig = {
  center: FREE_FINDS_CENTER,
  radiusKm: FREE_FINDS_RADIUS_KM,
  queries: [
    { query: "free computer", limit: 10, maxPages: 1 },
    { query: "free electronics", limit: 10, maxPages: 1 },
    { query: "free GPU", limit: 10, maxPages: 1 },
  ],
  maxPrice: 0,
  mode: "configuration_only",
};

export function freeFindsConfigPath(root: string): string { return join(root, FREE_FINDS_CONFIG_FILENAME); }

function number(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

export function validateFreeFindsConfig(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["Free Finds configuration must be an object."];
  const config = value as Partial<FreeFindsConfig>;
  if (!config.center || !number(config.center.latitude) || !number(config.center.longitude)) errors.push("Free Finds center must have numeric latitude and longitude.");
  if (config.center && (config.center.latitude < -90 || config.center.latitude > 90 || config.center.longitude < -180 || config.center.longitude > 180)) errors.push("Free Finds center coordinates are out of range.");
  if (!number(config.radiusKm) || config.radiusKm <= 0 || config.radiusKm > 500) errors.push("Free Finds radius must be greater than 0 and no more than 500 km.");
  if (config.maxPrice !== 0) errors.push("Free Finds maxPrice must remain exactly 0; paid results are not part of this mode.");
  if (config.mode !== "configuration_only") errors.push("Free Finds remains configuration-only until a safe run mechanism is documented.");
  if ("cadence" in config && config.cadence !== "manual_review_only") errors.push("Hourly or other automatic Free Finds cadence is unsupported; keep cadence manual_review_only.");
  if (!Array.isArray(config.queries) || config.queries.length === 0) errors.push("At least one Free Finds query is required.");
  const seen = new Set<string>();
  for (const [index, query] of (config.queries ?? []).entries()) {
    if (!query || typeof query !== "object") { errors.push(`Free Finds query ${index + 1} is invalid.`); continue; }
    if (typeof query.query !== "string" || !query.query.trim()) errors.push(`Free Finds query ${index + 1} must have text.`);
    const key = String(query.query ?? "").trim().toLowerCase();
    if (seen.has(key)) errors.push(`Duplicate Free Finds query: ${query.query}.`);
    seen.add(key);
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) errors.push(`Free Finds query ${index + 1} limit must be an integer from 1 to 50.`);
    if (!Number.isInteger(query.maxPages) || query.maxPages < 1 || query.maxPages > 3) errors.push(`Free Finds query ${index + 1} page count must be an integer from 1 to 3.`);
    if (query.latitude !== undefined && (!number(query.latitude) || query.latitude < -90 || query.latitude > 90)) errors.push(`Free Finds query ${index + 1} latitude is invalid.`);
    if (query.longitude !== undefined && (!number(query.longitude) || query.longitude < -180 || query.longitude > 180)) errors.push(`Free Finds query ${index + 1} longitude is invalid.`);
    if (query.radiusKm !== undefined && (!number(query.radiusKm) || query.radiusKm <= 0 || query.radiusKm > 500)) errors.push(`Free Finds query ${index + 1} radius must be greater than 0 and no more than 500 km.`);
    if (query.maxPrice !== undefined && query.maxPrice !== 0) errors.push(`Free Finds query ${index + 1} maxPrice must remain exactly 0.`);
  }
  return errors;
}

export function normalizeFreeFindsConfig(value: unknown): FreeFindsConfig {
  const input = value as Partial<FreeFindsConfig>;
  return {
    center: { latitude: input.center?.latitude ?? FREE_FINDS_CENTER.latitude, longitude: input.center?.longitude ?? FREE_FINDS_CENTER.longitude },
    radiusKm: input.radiusKm ?? FREE_FINDS_RADIUS_KM,
      queries: (input.queries ?? DEFAULT_FREE_FINDS_CONFIG.queries).map((query) => ({
        query: query.query, limit: query.limit ?? 10, maxPages: query.maxPages ?? 1,
        ...(query.latitude === undefined ? {} : { latitude: query.latitude }),
        ...(query.longitude === undefined ? {} : { longitude: query.longitude }),
        ...(query.radiusKm === undefined ? {} : { radiusKm: query.radiusKm }),
        maxPrice: 0 as const,
      })),
    maxPrice: 0,
    mode: "configuration_only",
  };
}

export async function loadFreeFindsConfig(root: string): Promise<FreeFindsConfig> {
  try {
    const value = JSON.parse(await readFile(freeFindsConfigPath(root), "utf8")) as unknown;
    if (validateFreeFindsConfig(value).length === 0) return normalizeFreeFindsConfig(value);
  } catch { /* use the safe local default */ }
  return DEFAULT_FREE_FINDS_CONFIG;
}

export async function saveFreeFindsConfig(root: string, value: unknown): Promise<FreeFindsConfig> {
  const errors = validateFreeFindsConfig(value);
  if (errors.length) throw new Error(errors.join(" "));
  const config = normalizeFreeFindsConfig(value);
  await writeFile(freeFindsConfigPath(root), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export function estimateFreeFindsWaitMs(config: FreeFindsConfig): number {
  return estimateRateLimitWaitRange(config.queries.reduce((total, query) => total + query.maxPages, 0)).maxMs;
}

export function previewFreeFindsReadiness(value: unknown): FreeFindsReadinessPreview {
  const errors = validateFreeFindsConfig(value);
  const input = value && typeof value === "object" ? value as Partial<FreeFindsConfig> : {};
  const queries = Array.isArray(input.queries) ? input.queries : [];
  const queryErrors = queries.map((query, index) => validateFreeFindsConfig({ ...DEFAULT_FREE_FINDS_CONFIG, ...input, queries: [query] }).filter((error) => !error.includes("At least one")));
  const requestCount = queries.reduce((total, query) => total + (Number.isInteger(query?.maxPages) ? Math.max(0, Number(query.maxPages)) : 0), 0);
  const resultSlots = queries.reduce((total, query) => total + (Number.isInteger(query?.limit) && Number.isInteger(query?.maxPages) ? Number(query.limit) * Number(query.maxPages) : 0), 0);
  const range = estimateRateLimitWaitRange(requestCount, DEFAULT_MAX_REQUESTS_PER_MINUTE);
  const warnings = [
    "Readiness is a local preview only; it does not call the MCP, start the watcher, or create a report.",
    "The MCP search center and radius are global for this planned pass; per-query center overrides are unsupported.",
    "max_price: 0 does not prove an item is genuinely free or still available; review remains manual.",
  ];
  const center = input.center && number(input.center.latitude) && number(input.center.longitude) ? input.center : null;
  const radiusKm = number(input.radiusKm) ? input.radiusKm : null;
  const querySummary = queries.map((query, index) => {
    const itemErrors = queryErrors[index] ?? [];
    const validLimit = Number.isInteger(query?.limit) && Number(query.limit) >= 1;
    const validPages = Number.isInteger(query?.maxPages) && Number(query.maxPages) >= 1;
    return {
      query: typeof query?.query === "string" ? query.query.trim() : "(invalid query)",
      resultLimit: validLimit ? Number(query.limit) : null,
      pages: validPages ? Number(query.maxPages) : null,
      resultSlots: validLimit && validPages ? Number(query.limit) * Number(query.maxPages) : 0,
      requests: validPages ? Number(query.maxPages) : 0,
      radiusKm: number(query?.radiusKm) ? query.radiusKm! : radiusKm,
      maxPrice: query?.maxPrice === undefined || query.maxPrice === 0 ? 0 : null,
      enabled: itemErrors.length === 0,
      errors: itemErrors,
    };
  });
  const ready = errors.length === 0;
  const summary = ready
    ? `${queries.length} enabled quer${queries.length === 1 ? "y" : "ies"} would request ${requestCount} Marketplace page${requestCount === 1 ? "" : "s"} and up to ${resultSlots} result slots around ${center ? `${center.latitude}, ${center.longitude}` : "an unknown center"} within ${radiusKm ?? "an unknown"} km. Estimated limiter wait: ${Math.round(range.minMs / 1000)}–${Math.round(range.maxMs / 1000)} seconds. This is review-only; no run is available.`
    : `Not ready: ${errors.length} configuration error${errors.length === 1 ? "" : "s"} must be fixed before a future run could be considered.`;
  return { ready, errors, warnings, requestCount, resultSlots, durationMs: { min: range.minMs, max: range.maxMs }, maxRequestsPerMinute: DEFAULT_MAX_REQUESTS_PER_MINUTE, center, radiusKm, queries: querySummary, summary };
}
