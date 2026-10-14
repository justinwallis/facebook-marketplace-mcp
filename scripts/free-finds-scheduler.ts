import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FREE_FINDS_SCHEDULER_FILENAME = "free-finds-scheduler.json";
export const FREE_FINDS_HOURLY_INTERVAL_MS = 60 * 60 * 1_000;
export const ENABLE_FREE_FINDS_CONFIRMATION = "ENABLE_FREE_FINDS_HOURLY";
export const DISABLE_FREE_FINDS_CONFIRMATION = "DISABLE_FREE_FINDS_HOURLY";

export type FreeFindsSchedulerConfig = {
  enabled: boolean;
  cadence: "hourly";
  intervalMs: number;
  nextRunAt: string | null;
  updatedAt: string | null;
};

export const DEFAULT_FREE_FINDS_SCHEDULER: FreeFindsSchedulerConfig = {
  enabled: false,
  cadence: "hourly",
  intervalMs: FREE_FINDS_HOURLY_INTERVAL_MS,
  nextRunAt: null,
  updatedAt: null,
};

export function freeFindsSchedulerPath(root: string): string { return join(root, FREE_FINDS_SCHEDULER_FILENAME); }

export type FreeFindsSchedulerState = {
  config: FreeFindsSchedulerConfig;
  valid: boolean;
  issue?: string;
};

export function validateFreeFindsScheduler(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["Free Finds scheduler configuration must be an object."];
  const config = value as Partial<FreeFindsSchedulerConfig>;
  const errors: string[] = [];
  if (config.cadence !== "hourly") errors.push("Free Finds scheduler cadence must be hourly.");
  if (config.intervalMs !== FREE_FINDS_HOURLY_INTERVAL_MS) errors.push("Free Finds hourly interval is fixed at 60 minutes.");
  if (typeof config.enabled !== "boolean") errors.push("Free Finds scheduler enabled must be boolean.");
  if (config.nextRunAt !== null && config.nextRunAt !== undefined && (typeof config.nextRunAt !== "string" || !Number.isFinite(Date.parse(config.nextRunAt)))) errors.push("Free Finds scheduler nextRunAt must be an ISO timestamp or null.");
  if (config.enabled === true && (typeof config.nextRunAt !== "string" || !Number.isFinite(Date.parse(config.nextRunAt)))) errors.push("Enabled Free Finds scheduler state must include a valid nextRunAt timestamp.");
  return errors;
}

export async function loadFreeFindsScheduler(root: string): Promise<FreeFindsSchedulerConfig> {
  return (await readFreeFindsSchedulerState(root)).config;
}

export async function readFreeFindsSchedulerState(root: string): Promise<FreeFindsSchedulerState> {
  try {
    const value = JSON.parse(await readFile(freeFindsSchedulerPath(root), "utf8")) as Partial<FreeFindsSchedulerConfig>;
    const errors = validateFreeFindsScheduler(value);
    if (errors.length === 0) return { config: { ...DEFAULT_FREE_FINDS_SCHEDULER, ...value }, valid: true };
    return { config: { ...DEFAULT_FREE_FINDS_SCHEDULER }, valid: false, issue: errors.join(" ") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: { ...DEFAULT_FREE_FINDS_SCHEDULER }, valid: true };
    return { config: { ...DEFAULT_FREE_FINDS_SCHEDULER }, valid: false, issue: `Free Finds scheduler state could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function nextFreeFindsRunAt(now: Date): string { return new Date(now.getTime() + FREE_FINDS_HOURLY_INTERVAL_MS).toISOString(); }

export async function saveFreeFindsScheduler(root: string, state: FreeFindsSchedulerConfig): Promise<FreeFindsSchedulerConfig> {
  const errors = validateFreeFindsScheduler(state);
  if (errors.length) throw new Error(errors.join(" "));
  await mkdir(root, { recursive: true });
  await writeFile(freeFindsSchedulerPath(root), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export async function setFreeFindsScheduler(root: string, enabled: boolean, confirmation: string, now = new Date()): Promise<FreeFindsSchedulerConfig> {
  const required = enabled ? ENABLE_FREE_FINDS_CONFIRMATION : DISABLE_FREE_FINDS_CONFIRMATION;
  if (confirmation !== required) throw new Error(`Explicit confirmation is required: ${required}.`);
  const state: FreeFindsSchedulerConfig = { enabled, cadence: "hourly", intervalMs: FREE_FINDS_HOURLY_INTERVAL_MS, nextRunAt: enabled ? nextFreeFindsRunAt(now) : null, updatedAt: now.toISOString() };
  return saveFreeFindsScheduler(root, state);
}
