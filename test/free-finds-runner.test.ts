import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEFAULT_FREE_FINDS_CONFIG, saveFreeFindsConfig } from "../scripts/free-finds-config.js";
import { runFreeFinds } from "../scripts/free-finds-runner.js";
import { DEFAULT_FREE_FINDS_SCHEDULER, DISABLE_FREE_FINDS_CONFIRMATION, ENABLE_FREE_FINDS_CONFIRMATION, FREE_FINDS_HOURLY_INTERVAL_MS, loadFreeFindsScheduler, nextFreeFindsRunAt, setFreeFindsScheduler, validateFreeFindsScheduler } from "../scripts/free-finds-scheduler.js";

function mockMcp(responses: Array<unknown | Error | "hang">) {
  let calls = 0;
  let closed = 0;
  const client = {
    async connect() {},
    async listTools() { return { tools: [{ name: "facebook_marketplace_search_listings" }] }; },
    async callTool(args: Record<string, unknown>) {
      void args;
      const response = responses[calls++] ?? { structuredContent: { listings: [] } };
      if (response === "hang") return await new Promise<never>(() => undefined);
      if (response instanceof Error) throw response;
      return response;
    },
    async close() { closed += 1; },
  };
  const transport = { async close() { closed += 1; } };
  return { client, transport, calls: () => calls, closed: () => closed };
}

test("Free Finds runner enforces bounds, deduplicates IDs, writes isolated receipts, and never needs a live client in tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "free-finds-runner-"));
  try {
    await saveFreeFindsConfig(root, { ...DEFAULT_FREE_FINDS_CONFIG, queries: [{ query: "free computers", limit: 2, maxPages: 1 }, { query: "free monitors", limit: 3, maxPages: 2 }] });
    await writeFile(join(root, "free-finds-report-previous.json"), JSON.stringify({ runAt: "2026-10-12T23:00:00.000Z", rawListings: [] }));
    const mock = mockMcp([
      { structuredContent: { listings: [{ id: "a", title: "Free PC" }, { id: "a", title: "duplicate" }] } },
      { structuredContent: { listings: [{ id: "b", title: "Free monitor" }] } },
    ]);
    const receipt = await runFreeFinds({ root, client: mock.client, transport: mock.transport, now: (() => { const values = [new Date("2026-10-13T01:00:00Z"), new Date("2026-10-13T01:00:01Z")]; return () => values.shift() ?? new Date("2026-10-13T01:00:01Z"); })(), requestTimeoutMs: 100, runTimeoutMs: 1_000 });
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.previousRunAt, "2026-10-12T23:00:00.000Z");
    assert.equal(receipt.comparisonSource, "free-finds-report-previous.json");
    assert.equal(receipt.deduplicatedListingCount, 2);
    assert.equal(receipt.receipt.queryCount, 2);
    assert.equal(receipt.receipt.pageCount, 3);
    assert.equal(receipt.queries[0].limit, 2);
    assert.equal(receipt.queries[1].maxPages, 2);
    assert.equal(mock.calls(), 2);
    assert.equal(mock.closed(), 2);
    const reportNames = (await readdir(root)).filter((name) => name.startsWith("free-finds-report-"));
    assert.equal(reportNames.length, 2);
    assert.equal((await readdir(root)).some((name) => name.startsWith("report-") || name === "state.json"), false);
    const report = JSON.parse(await readFile(join(root, reportNames[0]), "utf8"));
    assert.equal(report.readOnly, true);
    assert.equal(report.monitorsCreated, false);
    assert.equal(report.queries[0].limit, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Free Finds runner reports partial failures and shuts down cleanly after a hung search timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "free-finds-timeout-"));
  try {
    await saveFreeFindsConfig(root, { ...DEFAULT_FREE_FINDS_CONFIG, queries: [{ query: "first", limit: 1, maxPages: 1 }, { query: "hung", limit: 1, maxPages: 1 }] });
    const mock = mockMcp([{ structuredContent: { listings: [{ id: "ok" }] } }, "hang"]);
    const receipt = await runFreeFinds({ root, client: mock.client, transport: mock.transport, requestTimeoutMs: 20, runTimeoutMs: 60 });
    assert.ok(receipt.status === "partial" || receipt.status === "failed");
    assert.ok(receipt.errors.some((error) => /timed out/i.test(error.error)));
    assert.equal(mock.closed(), 2);
    assert.equal((await readdir(root)).filter((name) => name.startsWith("free-finds-report-")).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Free Finds runner blocks invalid execution settings and prevents overlapping runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "free-finds-guard-"));
  try {
    await writeFile(join(root, "free-finds-configuration.json"), JSON.stringify({ ...DEFAULT_FREE_FINDS_CONFIG, queries: [{ query: "", limit: 0, maxPages: 99 }] }));
    const invalidMock = mockMcp([]);
    const blocked = await runFreeFinds({ root, client: invalidMock.client, transport: invalidMock.transport });
    assert.equal(blocked.status, "blocked");
    assert.equal(invalidMock.calls(), 0);
    await saveFreeFindsConfig(root, { ...DEFAULT_FREE_FINDS_CONFIG, queries: [{ query: "hang", limit: 1, maxPages: 1 }] });
    const firstMock = mockMcp(["hang"]);
    const first = runFreeFinds({ root, client: firstMock.client, transport: firstMock.transport, requestTimeoutMs: 20, runTimeoutMs: 40 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(runFreeFinds({ root, client: mockMcp([]).client, transport: mockMcp([]).transport }), /already in progress/);
    await first;
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Free Finds scheduler is disabled by default, calculates hourly next runs, and requires confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "free-finds-scheduler-"));
  try {
    assert.deepEqual(await loadFreeFindsScheduler(root), DEFAULT_FREE_FINDS_SCHEDULER);
    const now = new Date("2026-10-13T01:00:00Z");
    assert.equal(nextFreeFindsRunAt(now), "2026-10-13T02:00:00.000Z");
    assert.deepEqual(validateFreeFindsScheduler(DEFAULT_FREE_FINDS_SCHEDULER), []);
    await assert.rejects(setFreeFindsScheduler(root, true, "wrong", now), /Explicit confirmation/);
    const enabled = await setFreeFindsScheduler(root, true, ENABLE_FREE_FINDS_CONFIRMATION, now);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.nextRunAt, "2026-10-13T02:00:00.000Z");
    assert.equal(enabled.intervalMs, FREE_FINDS_HOURLY_INTERVAL_MS);
    await assert.rejects(setFreeFindsScheduler(root, false, "wrong", now), /Explicit confirmation/);
    const disabled = await setFreeFindsScheduler(root, false, DISABLE_FREE_FINDS_CONFIRMATION, now);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRunAt, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
