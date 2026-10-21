import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FREE_FINDS_HOURLY_INTERVAL_MS, saveFreeFindsScheduler, type FreeFindsSchedulerConfig } from "../scripts/free-finds-scheduler.ts";
import { FREE_FINDS_SCHEDULER_LOG_FILENAME, FreeFindsSchedulerService, isFreeFindsProcessAlive } from "../scripts/free-finds-service.ts";
import { FREE_FINDS_REPORT_RETENTION_COUNT, FREE_FINDS_SCHEDULER_LOG_BACKUP_FILENAME, FREE_FINDS_SCHEDULER_LOG_MAX_BYTES, pruneFreeFindsReports } from "../scripts/free-finds-retention.ts";
import type { FreeFindsRunReceipt } from "../scripts/free-finds-runner.ts";

async function tempRoot(): Promise<string> { return mkdtemp(join(tmpdir(), "free-finds-service-")); }
function receipt(status: FreeFindsRunReceipt["status"] = "complete"): FreeFindsRunReceipt {
  const now = new Date().toISOString();
  return { mode: "free_finds", runAt: now, startedAt: now, endedAt: now, status, readOnly: true, monitorsCreated: false, comparisonSource: null, previousRunAt: null, configuration: null, center: null, radiusKm: null, queries: [], rawListings: [], deduplicatedListingCount: 0, errors: status === "complete" ? [] : [{ stage: "search", error: "mock failure" }], receipt: { startedAt: now, endedAt: now, queryCount: 0, pageCount: 0, errorCount: status === "complete" ? 0 : 1, comparisonSource: null } };
}
async function enable(root: string, nextRunAt: string): Promise<void> {
  const state: FreeFindsSchedulerConfig = { enabled: true, cadence: "hourly", intervalMs: FREE_FINDS_HOURLY_INTERVAL_MS, nextRunAt, updatedAt: new Date().toISOString() };
  await saveFreeFindsScheduler(root, state);
}
function fakeClock(start = "2026-10-13T12:00:00.000Z") {
  let current = Date.parse(start);
  let id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => new Date(current),
    setTimeout: (callback: () => void, delay: number) => { const timer = ++id; timers.set(timer, { at: current + delay, callback }); return timer; },
    clearTimeout: (timer: unknown) => { timers.delete(timer as number); },
    async advance(ms: number) { current += ms; const due = [...timers.entries()].filter(([, value]) => value.at <= current); for (const [timer, value] of due) { timers.delete(timer); value.callback(); } },
    timers,
  };
}

test("disabled or malformed persisted state starts safely without running", async () => {
  const root = await tempRoot();
  let calls = 0;
  const service = new FreeFindsSchedulerService({ root, run: async () => { calls += 1; return receipt(); } });
  const health = await service.start();
  assert.equal(health.processRunning, true);
  assert.equal(health.enabled, false);
  assert.equal(calls, 0);
  await service.shutdown();
  await writeFile(join(root, "free-finds-scheduler.json"), "{not json", "utf8");
  const malformed = new FreeFindsSchedulerService({ root, run: async () => { calls += 1; return receipt(); } });
  const malformedHealth = await malformed.start();
  assert.equal(malformedHealth.validState, false);
  assert.equal(malformedHealth.enabled, false);
  assert.equal(calls, 0);
  await malformed.shutdown();
});

test("enabled state without a scheduled timestamp is invalid and cannot trigger recovery", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "free-finds-scheduler.json"), JSON.stringify({ enabled: true, cadence: "hourly", intervalMs: FREE_FINDS_HOURLY_INTERVAL_MS, nextRunAt: null, updatedAt: new Date().toISOString() }), "utf8");
  let calls = 0;
  const service = new FreeFindsSchedulerService({ root, run: async () => { calls += 1; return receipt(); } });
  const health = await service.start();
  assert.equal(health.validState, false);
  assert.equal(health.enabled, false);
  assert.equal(health.nextRunAt, null);
  assert.equal(calls, 0);
  await service.shutdown();
});

test("enabled service schedules one mock run at the hourly cadence and persists next run", async () => {
  const root = await tempRoot();
  const clock = fakeClock();
  await enable(root, new Date(Date.parse("2026-10-13T12:00:00.000Z") + FREE_FINDS_HOURLY_INTERVAL_MS).toISOString());
  let calls = 0;
  let resolveRunStarted!: () => void;
  const runStarted = new Promise<void>((resolve) => { resolveRunStarted = resolve; });
  const service = new FreeFindsSchedulerService({ root, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, run: async () => { calls += 1; resolveRunStarted(); return receipt(); } });
  await service.start();
  assert.equal(calls, 0);
  await clock.advance(FREE_FINDS_HOURLY_INTERVAL_MS);
  await runStarted;
  assert.equal(calls, 1);
  assert.match(service.getHealth().nextRunAt ?? "", /13:00:00/);
  await service.shutdown();
});

test("restart recovers one missed tick, does not replay all missed intervals, and logs outcomes", async () => {
  const root = await tempRoot();
  const clock = fakeClock();
  await enable(root, "2026-10-13T08:00:00.000Z");
  let calls = 0;
  const service = new FreeFindsSchedulerService({ root, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, run: async () => { calls += 1; return receipt(); } });
  await service.start();
  assert.equal(calls, 1);
  assert.equal(service.getHealth().missedTicks, 1);
  const log = await readFile(join(root, FREE_FINDS_SCHEDULER_LOG_FILENAME), "utf8");
  assert.match(log, /missed_tick/);
  await service.shutdown();
});

test("overlapping ticks are skipped and shutdown waits for the active run", async () => {
  const root = await tempRoot();
  const clock = fakeClock();
  await enable(root, "2026-10-13T13:00:00.000Z");
  let resolveRun!: () => void;
  const pending = new Promise<void>((resolve) => { resolveRun = resolve; });
  let calls = 0;
  const service = new FreeFindsSchedulerService({ root, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, run: async () => { calls += 1; await pending; return receipt(); } });
  await service.start();
  const started = service.runTick();
  for (let i = 0; i < 8 && calls === 0; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  await service.runTick();
  assert.equal(calls, 1);
  assert.equal(service.getHealth().missedTicks, 1);
  const stopping = service.shutdown();
  assert.equal(service.getHealth().processRunning, true);
  resolveRun();
  await stopping;
  await started;
  assert.equal(service.getHealth().processRunning, false);
});

test("runner failure is recorded without touching Hardware Watch reports", async () => {
  const root = await tempRoot();
  const clock = fakeClock();
  await enable(root, "2026-10-13T08:00:00.000Z");
  const service = new FreeFindsSchedulerService({ root, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, run: async () => { throw new Error("mock runner failure"); } });
  await service.start();
  assert.equal(service.getHealth().lastStatus, "failed");
  assert.equal(service.getHealth().lastError, "mock runner failure");
  const files = await readdir(root);
  assert.deepEqual(files.sort(), ["free-finds-scheduler.json", "free-finds-scheduler-health.json", FREE_FINDS_SCHEDULER_LOG_FILENAME].sort());
  await service.shutdown();
});

test("service tests use an injected runner and never invoke the live MCP client", async () => {
  const root = await tempRoot();
  const service = new FreeFindsSchedulerService({ root, run: async () => receipt() });
  const health = await service.start();
  assert.equal(health.enabled, false);
  await service.shutdown();
});

test("status liveness accepts the current process and rejects a stale PID", () => {
  assert.equal(isFreeFindsProcessAlive(process.pid), true);
  assert.equal(isFreeFindsProcessAlive(99999999), false);
  assert.equal(isFreeFindsProcessAlive(null), false);
});

test("retention keeps recent Free Finds reports, preserves malformed diagnostics, and rotates oversized logs", async () => {
  const root = await tempRoot();
  for (let index = 0; index < FREE_FINDS_REPORT_RETENTION_COUNT + 2; index += 1) {
    const runAt = new Date(Date.parse("2026-10-13T00:00:00.000Z") + index * 60 * 60 * 1_000).toISOString();
    await writeFile(join(root, `free-finds-report-${runAt.replace(/[:.]/g, "-")}.json`), JSON.stringify({ runAt }), "utf8");
  }
  await writeFile(join(root, "free-finds-report-malformed.json"), "not json", "utf8");
  await writeFile(join(root, FREE_FINDS_SCHEDULER_LOG_FILENAME), "x".repeat(FREE_FINDS_SCHEDULER_LOG_MAX_BYTES + 1), "utf8");
  const removed = await pruneFreeFindsReports(root);
  assert.equal(removed.length, 2);
  assert.equal((await readdir(root)).filter((name) => name.startsWith("free-finds-report-")).length, FREE_FINDS_REPORT_RETENTION_COUNT + 1);
  const service = new FreeFindsSchedulerService({ root, run: async () => receipt() });
  await service.start();
  assert.equal((await readdir(root)).includes(FREE_FINDS_SCHEDULER_LOG_BACKUP_FILENAME), true);
  await service.shutdown();
});
