import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFreeFinds, type FreeFindsRunReceipt } from "./free-finds-runner.js";
import { FREE_FINDS_HOURLY_INTERVAL_MS, nextFreeFindsRunAt, readFreeFindsSchedulerState, saveFreeFindsScheduler, type FreeFindsSchedulerConfig } from "./free-finds-scheduler.js";
import { pruneFreeFindsReports, rotateFreeFindsSchedulerLog } from "./free-finds-retention.js";

export const FREE_FINDS_SCHEDULER_LOG_FILENAME = "free-finds-scheduler.log";
export const FREE_FINDS_SCHEDULER_HEALTH_FILENAME = "free-finds-scheduler-health.json";

export type FreeFindsSchedulerHealth = {
  pid: number | null;
  processRunning: boolean;
  enabled: boolean;
  validState: boolean;
  cadence: "hourly";
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: FreeFindsRunReceipt["status"] | "failed" | null;
  lastError: string | null;
  missedTicks: number;
  shutdownRequested: boolean;
  issue?: string;
};

type Timer = unknown;
type SchedulerServiceOptions = {
  root: string;
  now?: () => Date;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  run?: () => Promise<FreeFindsRunReceipt>;
  log?: (message: string) => void;
};

function defaultNow(): Date { return new Date(); }
function defaultSetTimeout(callback: () => void, delayMs: number): Timer { return setTimeout(callback, delayMs); }
function defaultClearTimeout(timer: Timer): void { clearTimeout(timer as NodeJS.Timeout); }

export class FreeFindsSchedulerService {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly run: () => Promise<FreeFindsRunReceipt>;
  private readonly log: (message: string) => void;
  private timer: Timer | null = null;
  private activeRun: Promise<void> | null = null;
  private health: FreeFindsSchedulerHealth = { pid: null, processRunning: false, enabled: false, validState: true, cadence: "hourly", nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null, missedTicks: 0, shutdownRequested: false };

  constructor(options: SchedulerServiceOptions) {
    this.root = options.root;
    this.now = options.now ?? defaultNow;
    this.setTimer = options.setTimeout ?? defaultSetTimeout;
    this.clearTimer = options.clearTimeout ?? defaultClearTimeout;
    this.run = options.run ?? (() => runFreeFinds({ root: this.root }));
    this.log = options.log ?? ((message) => process.stderr.write(`[free-finds-scheduler] ${message}\n`));
  }

  getHealth(): FreeFindsSchedulerHealth { return { ...this.health }; }

  async start(): Promise<FreeFindsSchedulerHealth> {
    await mkdir(this.root, { recursive: true });
    const state = await readFreeFindsSchedulerState(this.root);
    this.health = { ...this.health, pid: process.pid, processRunning: true, enabled: state.valid && state.config.enabled, validState: state.valid, nextRunAt: state.valid && state.config.enabled ? state.config.nextRunAt : null, issue: state.issue };
    await this.writeHealth();
    await this.writeEvent({ event: "started", enabled: this.health.enabled, validState: state.valid, nextRunAt: this.health.nextRunAt, issue: state.issue });
    if (!state.valid || !state.config.enabled) {
      this.log(state.valid ? "started disabled" : `started disabled: ${state.issue ?? "invalid scheduler state"}`);
      return this.getHealth();
    }
    const next = state.config.nextRunAt ? Date.parse(state.config.nextRunAt) : NaN;
    if (!Number.isFinite(next) || next <= this.now().getTime()) {
      this.health.missedTicks += 1;
      await this.writeEvent({ event: "missed_tick", scheduledAt: state.config.nextRunAt, action: "single_recovery_run" });
      await this.runTick();
    } else {
      this.schedule(next - this.now().getTime());
    }
    return this.getHealth();
  }

  private schedule(delayMs: number): void {
    if (!this.health.processRunning || !this.health.enabled || this.health.shutdownRequested) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { void this.runTick(); }, Math.max(0, delayMs));
  }

  async runTick(): Promise<void> {
    if (!this.health.processRunning || this.health.shutdownRequested) return;
    const state = await readFreeFindsSchedulerState(this.root);
    if (!state.valid || !state.config.enabled) {
      this.health.enabled = false;
      this.health.validState = state.valid;
      this.health.nextRunAt = null;
      this.health.issue = state.issue;
      await this.writeHealth();
      return;
    }
    this.health.enabled = true;
    if (this.activeRun) {
      this.health.missedTicks += 1;
      await this.writeEvent({ event: "tick_skipped", reason: "run_in_progress" });
      this.schedule(FREE_FINDS_HOURLY_INTERVAL_MS);
      return;
    }
    const runStartedAt = this.now().toISOString();
    this.activeRun = (async () => {
      try {
        const receipt = await this.run();
        this.health.lastRunAt = receipt.endedAt;
        this.health.lastStatus = receipt.status;
        this.health.lastError = receipt.errors[0]?.error ?? null;
        await this.writeEvent({ event: "run_finished", status: receipt.status, startedAt: receipt.startedAt, endedAt: receipt.endedAt, errorCount: receipt.errors.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.health.lastRunAt = runStartedAt;
        this.health.lastStatus = "failed";
        this.health.lastError = message;
        await this.writeEvent({ event: "run_failed", startedAt: runStartedAt, error: message });
      }
    })();
    try { await this.activeRun; } finally { this.activeRun = null; }
    if (!this.health.shutdownRequested) {
      await this.applyRetention();
      const refreshed = await readFreeFindsSchedulerState(this.root);
      if (refreshed.valid && refreshed.config.enabled) {
        const nextRunAt = nextFreeFindsRunAt(this.now());
        const nextState: FreeFindsSchedulerConfig = { ...refreshed.config, nextRunAt, updatedAt: this.now().toISOString() };
        await saveFreeFindsScheduler(this.root, nextState);
        this.health.nextRunAt = nextRunAt;
        this.schedule(FREE_FINDS_HOURLY_INTERVAL_MS);
      } else {
        this.health.enabled = false;
        this.health.nextRunAt = null;
      }
      await this.writeHealth();
    }
  }

  async shutdown(): Promise<void> {
    if (!this.health.processRunning) return;
    this.health.shutdownRequested = true;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    if (this.activeRun) await this.activeRun;
    this.health.processRunning = false;
    this.health.pid = null;
    await this.writeHealth();
    await this.writeEvent({ event: "stopped", lastRunAt: this.health.lastRunAt, lastStatus: this.health.lastStatus });
  }

  private async writeEvent(event: Record<string, unknown>): Promise<void> {
    await rotateFreeFindsSchedulerLog(this.root);
    await appendFile(resolve(this.root, FREE_FINDS_SCHEDULER_LOG_FILENAME), `${JSON.stringify({ at: this.now().toISOString(), ...event })}\n`, "utf8");
  }

  private async applyRetention(): Promise<void> {
    try {
      const removed = await pruneFreeFindsReports(this.root);
      if (removed.length) await this.writeEvent({ event: "retention_pruned", reportCount: removed.length, reports: removed });
    } catch (error) {
      await this.writeEvent({ event: "retention_error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async writeHealth(): Promise<void> {
    await writeFile(resolve(this.root, FREE_FINDS_SCHEDULER_HEALTH_FILENAME), `${JSON.stringify({ ...this.health, updatedAt: this.now().toISOString() }, null, 2)}\n`, "utf8");
  }
}

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const defaultRoot = resolve(process.env.FREE_FINDS_OUTPUT_DIR ?? resolve(repoRoot, ".local/hardware-watch"));

export function isFreeFindsProcessAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function main(): Promise<void> {
  if (process.argv.includes("--status")) {
    const state = await readFreeFindsSchedulerState(defaultRoot);
    let health: Record<string, unknown> | null = null;
    try { health = JSON.parse(await readFile(resolve(defaultRoot, FREE_FINDS_SCHEDULER_HEALTH_FILENAME), "utf8")) as Record<string, unknown>; } catch { /* no running service has published health */ }
    const processRunning = Boolean(health?.processRunning) && isFreeFindsProcessAlive(health?.pid);
    console.log(JSON.stringify(health ? { ...health, processRunning, scheduler: state.config, validState: state.valid, issue: state.issue ?? null } : { pid: null, processRunning: false, ...state.config, validState: state.valid, issue: state.issue ?? null }, null, 2));
    return;
  }
  const service = new FreeFindsSchedulerService({ root: defaultRoot });
  await service.start();
  console.log(JSON.stringify(service.getHealth(), null, 2));
  const stop = () => { void service.shutdown().finally(() => { process.exitCode = 0; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>((resolvePromise) => {
    const check = () => service.getHealth().processRunning ? setTimeout(check, 250) : resolvePromise();
    check();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[free-finds-scheduler] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
