import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  DEFAULT_WATCH_CONFIG,
  applyPendingConfiguration,
  configPaths,
  discardPendingConfiguration,
  diffWatchConfig,
  estimateRateLimitWaitMs,
  loadActiveWatchConfig,
  loadConfigurationState,
  rateLimitSummary,
  revertLastAppliedConfiguration,
  savePendingConfiguration,
  validateWatchConfig,
} from "../scripts/hardware-watch-config.js";

function configWith(overrides: Partial<typeof DEFAULT_WATCH_CONFIG> = {}) {
  return { ...DEFAULT_WATCH_CONFIG, ...overrides, queries: overrides.queries ?? [...DEFAULT_WATCH_CONFIG.queries] };
}

test("validates query edits, duplicate queries, and max_price zero", () => {
  const config = configWith({ queries: [{ kind: "proxmox", query: "Free GPU", limit: 10, maxPages: 1, minPrice: 0, maxPrice: 0 }, { kind: "proxmox", query: "free gpu", limit: 10, maxPages: 1, minPrice: null, maxPrice: null }] });
  const errors = validateWatchConfig(config);
  assert.ok(errors.some((error) => error.includes("Duplicate query")));
  assert.ok(!errors.some((error) => error.includes("maxPrice")));
});

test("reports query additions, removals, edits, and reordering", () => {
  const active = configWith();
  const proposed = configWith({ radiusKm: 90, queries: [
    { ...active.queries[1], limit: 5 },
    { kind: "proxmox", query: "Free GPU", limit: 10, maxPages: 1, minPrice: null, maxPrice: 0 },
  ] });
  const diff = diffWatchConfig(active, proposed).join(" | ");
  assert.match(diff, /Radius: 80 km → 90 km/);
  assert.match(diff, /Removed query/);
  assert.match(diff, /Added query: proxmox:Free GPU/);
});

test("saves pending config, requires confirmation, backs up active config, and reverts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-config-"));
  try {
    const proposed = configWith({ queries: [{ kind: "proxmox", query: "Free GPU", limit: 4, maxPages: 1, minPrice: 0, maxPrice: 0 }] });
    await savePendingConfiguration(directory, proposed);
    assert.deepEqual(await loadActiveWatchConfig(directory), DEFAULT_WATCH_CONFIG);
    await assert.rejects(() => applyPendingConfiguration(directory, ""), /Explicit confirmation/);
    const applied = await applyPendingConfiguration(directory, "APPLY_NEXT_RUN");
    assert.equal(applied.active.queries[0].maxPrice, 0);
    assert.equal(applied.pending, null);
    assert.equal(applied.hasBackup, true);
    assert.match(await readFile(configPaths(directory).backup, "utf8"), /Mac Studio Max/);
    await assert.rejects(() => revertLastAppliedConfiguration(directory, ""), /Explicit confirmation/);
    const reverted = await revertLastAppliedConfiguration(directory, "REVERT_LAST_APPLIED");
    assert.equal(reverted.active.queries.length, DEFAULT_WATCH_CONFIG.queries.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Hardware Watch configuration writers create a missing parent directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "hardware-watch-missing-parent-"));
  const directory = join(parent, "new", "config");
  try {
    await savePendingConfiguration(directory, configWith({ radiusKm: 90 }));
    await applyPendingConfiguration(directory, "APPLY_NEXT_RUN");
    assert.equal((await loadConfigurationState(directory)).hasBackup, true);
    await revertLastAppliedConfiguration(directory, "REVERT_LAST_APPLIED");
    assert.deepEqual(await loadActiveWatchConfig(directory), DEFAULT_WATCH_CONFIG);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("the next watcher config load sees an applied config, and revert restores the exact prior config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-config-lifecycle-"));
  try {
    const paths = configPaths(directory);
    const prior = configWith({
      radiusKm: 72,
      queries: [{ kind: "proxmox", query: "prior fixture", limit: 3, maxPages: 1, minPrice: null, maxPrice: null }],
    });
    const proposed = configWith({
      radiusKm: 88,
      queries: [{ kind: "mac", query: "applied fixture", limit: 2, maxPages: 1, minPrice: null, maxPrice: 1900 }],
    });
    await writeFile(paths.active, `${JSON.stringify(prior)}\n`, "utf8");
    const activeBeforeDraft = await loadActiveWatchConfig(directory);

    await savePendingConfiguration(directory, proposed);
    assert.deepEqual(await loadActiveWatchConfig(directory), activeBeforeDraft, "a draft must not affect the next watcher load");
    await assert.rejects(() => applyPendingConfiguration(directory, "CONFIRM_LATER"), /Explicit confirmation/);
    assert.deepEqual(await loadActiveWatchConfig(directory), activeBeforeDraft, "failed confirmation must not apply the draft");

    await applyPendingConfiguration(directory, "APPLY_NEXT_RUN");
    assert.deepEqual(await loadActiveWatchConfig(directory), proposed, "the normal active-config loader must see the applied config");
    const backupAfterApply = await readFile(paths.backup, "utf8");
    const backupValue = JSON.parse(backupAfterApply) as typeof prior & { backedUpAt: string };
    assert.deepEqual({ ...backupValue, backedUpAt: undefined }, { ...prior, backedUpAt: undefined });
    assert.equal(typeof backupValue.backedUpAt, "string");

    await revertLastAppliedConfiguration(directory, "REVERT_LAST_APPLIED");
    assert.deepEqual(await loadActiveWatchConfig(directory), prior, "revert must restore the exact prior active config");
    assert.equal(await readFile(paths.backup, "utf8"), backupAfterApply, "revert must preserve the recoverable backup");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("estimates the configured limiter without invoking a client", () => {
  const config = configWith({ queries: Array.from({ length: 4 }, (_, index) => ({ kind: "proxmox", query: `q${index}`, limit: 10, maxPages: 1, minPrice: null, maxPrice: null })) });
  assert.equal(estimateRateLimitWaitMs(config), 63750);
  assert.match(rateLimitSummary(config), /3 requests\/minute/);
});

test("discards only a confirmed pending config and preserves active config and backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-config-discard-"));
  try {
    const paths = configPaths(directory);
    await savePendingConfiguration(directory, configWith({ radiusKm: 90 }));
    const pendingBefore = await readFile(paths.pending, "utf8");
    await assert.rejects(() => discardPendingConfiguration(directory, ""), /Explicit confirmation/);
    assert.equal(await readFile(paths.pending, "utf8"), pendingBefore);
    await writeFile(paths.active, `${JSON.stringify(configWith({ radiusKm: 79 }))}\n`, "utf8");
    await writeFile(paths.backup, `${JSON.stringify({ ...configWith({ radiusKm: 78 }), backedUpAt: "test" })}\n`, "utf8");
    const activeBefore = await readFile(paths.active, "utf8");
    const backupBefore = await readFile(paths.backup, "utf8");
    const state = await discardPendingConfiguration(directory, "DISCARD_PENDING");
    assert.equal(state.pending, null);
    assert.equal(state.hasBackup, true);
    await assert.rejects(() => readFile(paths.pending, "utf8"), /ENOENT/);
    assert.equal(await readFile(paths.active, "utf8"), activeBefore);
    assert.equal(await readFile(paths.backup, "utf8"), backupBefore);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
