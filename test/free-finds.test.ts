import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEFAULT_FREE_FINDS_CONFIG, estimateFreeFindsWaitMs, normalizeFreeFindsConfig, previewFreeFindsReadiness, saveFreeFindsConfig, validateFreeFindsConfig } from "../scripts/free-finds-config.js";
import { FREE_FINDS_PICKUP_STATUSES, loadFreeFindsReviews, saveFreeFindsReview, saveFreeFindsReviews } from "../scripts/free-finds-review.js";
import { ENABLE_FREE_FINDS_CONFIRMATION, setFreeFindsScheduler } from "../scripts/free-finds-scheduler.js";
import { classifyFreeFindsPrice, filterFreeFindsByQuery, FREE_FINDS_STALE_AFTER_MS, freeFindsDistanceAvailable, freeFindsDistanceLabel, loadFreeFindsListings, loadFreeFindsRunHistory, matchesFreeFindsTriage, normalizeFreeFindsImageUrl, selectFreeFindsBulkIds, summarizeFreeFindsAttention, summarizeFreeFindsListings } from "../scripts/free-finds-dashboard-lib.js";
import { DEFAULT_MAX_REQUESTS_PER_MINUTE, INTER_REQUEST_JITTER_MS, WINDOW_WAIT_JITTER_MS } from "../src/utils/rate-limit.js";

test("Free Finds configuration is isolated, validates duplicates, bounds, and unsupported cadence", async () => {
  assert.deepEqual(validateFreeFindsConfig(DEFAULT_FREE_FINDS_CONFIG), []);
  assert.match(validateFreeFindsConfig({ ...DEFAULT_FREE_FINDS_CONFIG, cadence: "hourly" } as any).join(" "), /automatic.*unsupported/);
  assert.match(validateFreeFindsConfig({ ...DEFAULT_FREE_FINDS_CONFIG, maxPrice: 10 } as any).join(" "), /exactly 0/);
  assert.match(validateFreeFindsConfig({ ...DEFAULT_FREE_FINDS_CONFIG, queries: [{ query: "Free", limit: 0, maxPages: 4 }, { query: "free", limit: 10, maxPages: 1 }] }).join(" "), /Duplicate/);
  assert.deepEqual(validateFreeFindsConfig({ ...DEFAULT_FREE_FINDS_CONFIG, queries: [{ query: "free", limit: 10, maxPages: 1, radiusKm: 40, maxPrice: 0 }] }), []);
  assert.match(validateFreeFindsConfig({ ...DEFAULT_FREE_FINDS_CONFIG, queries: [{ query: "free", limit: 10, maxPages: 1, latitude: 39.56 }] as any }).join(" "), /per-query center overrides are unsupported/);
  assert.match(validateFreeFindsConfig({ ...DEFAULT_FREE_FINDS_CONFIG, queries: [{ query: "free", limit: 10, maxPages: 1, maxPrice: 1 as any }] }).join(" "), /maxPrice/);
  const directory = await mkdtemp(join(tmpdir(), "free-finds-config-"));
  try {
    const saved = await saveFreeFindsConfig(directory, DEFAULT_FREE_FINDS_CONFIG);
    assert.equal(saved.mode, "configuration_only");
    assert.equal(JSON.parse(await readFile(join(directory, "free-finds-configuration.json"), "utf8")).maxPrice, 0);
    assert.equal(estimateFreeFindsWaitMs(normalizeFreeFindsConfig({ ...DEFAULT_FREE_FINDS_CONFIG, queries: [{ query: "a", limit: 1, maxPages: 2 }] })), INTER_REQUEST_JITTER_MS.max);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Free Finds local state writers create a missing parent directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "free-finds-missing-parent-"));
  const directory = join(parent, "new", "state");
  try {
    await saveFreeFindsConfig(directory, DEFAULT_FREE_FINDS_CONFIG);
    await saveFreeFindsReview(directory, "free-1", { status: "Interested" });
    await setFreeFindsScheduler(directory, true, ENABLE_FREE_FINDS_CONFIRMATION, new Date("2026-10-13T01:00:00Z"));
    assert.equal((await loadFreeFindsReviews(directory)).reviews["free-1"].status, "Interested");
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("Free Finds readiness preview matches the configured limiter and reports global location behavior", () => {
  const preview = previewFreeFindsReadiness(DEFAULT_FREE_FINDS_CONFIG);
  assert.equal(preview.ready, true);
  assert.equal(preview.requestCount, 3);
  assert.equal(preview.resultSlots, 30);
  assert.equal(preview.maxRequestsPerMinute, DEFAULT_MAX_REQUESTS_PER_MINUTE);
  assert.deepEqual(preview.durationMs, { min: INTER_REQUEST_JITTER_MS.min * 2, max: INTER_REQUEST_JITTER_MS.max * 2 });
  assert.match(preview.warnings.join(" "), /per-query center overrides are unsupported/i);
  assert.match(preview.summary, /3 enabled queries/);
  assert.equal(WINDOW_WAIT_JITTER_MS.min, 1_000);
});

test("Free Finds readiness blocks invalid settings without invoking a client or watcher", () => {
  const preview = previewFreeFindsReadiness({ ...DEFAULT_FREE_FINDS_CONFIG, mode: "running", queries: [{ query: "", limit: 0, maxPages: 4 }] });
  assert.equal(preview.ready, false);
  assert.ok(preview.errors.length >= 3);
  assert.match(preview.summary, /Not ready/);
  assert.match(preview.errors.join(" "), /configuration-only|text|limit|page/i);
});

test("Free Finds reviews persist separately with pickup-specific states and notes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free-finds-reviews-"));
  try {
    await saveFreeFindsReview(directory, "free-1", { status: "Pickup planned", pickupNotes: "Saturday curb pickup", pickupAt: "2026-10-17T14:00", notes: "Bring a cart" });
    const loaded = await loadFreeFindsReviews(directory);
    assert.equal(loaded.reviews["free-1"].status, "Pickup planned");
    assert.equal(loaded.reviews["free-1"].pickupStatus, "None");
    assert.equal(loaded.reviews["free-1"].pickupNotes, "Saturday curb pickup");
    assert.equal(loaded.reviews["free-1"].pickupAt, "2026-10-17T14:00");
    await saveFreeFindsReview(directory, "free-1", { status: "Interested", pickupStatus: "Contacted", pickupNotes: "Seller replied", pickupAt: null, notes: "Personal follow-up" });
    const contacted = (await loadFreeFindsReviews(directory)).reviews["free-1"];
    assert.equal(contacted.status, "Interested");
    assert.equal(contacted.pickupStatus, "Contacted");
    assert.equal(contacted.pickupNotes, "Seller replied");
    await saveFreeFindsReview(directory, "free-1", { status: "Collected", pickupStatus: "Collected", pickupNotes: "Collected", pickupAt: null, notes: "Done" });
    const collected = (await loadFreeFindsReviews(directory)).reviews["free-1"];
    assert.equal(collected.status, "Collected");
    assert.equal(collected.pickupStatus, "Collected");
    assert.deepEqual(FREE_FINDS_PICKUP_STATUSES, ["None", "Interested", "Contacted", "Claimed/gone", "Collected", "No longer interested"]);
    assert.equal((await readFile(join(directory, "free-finds-reviews.json"), "utf8")).includes("Hardware"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Free Finds saved listing view attaches isolated reviews and marks new/updated state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free-finds-view-"));
  try {
    await writeFile(join(directory, "free-finds-report-2026-10-13T01-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-13T01:00:00.000Z", errors: [], rawListings: [{ id: "old", title: "Free desk", price: "$0" }] }));
    await writeFile(join(directory, "free-finds-report-2026-10-13T02-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-13T02:00:00.000Z", previousRunAt: "2026-10-13T01:00:00.000Z", errors: [], rawListings: [{ id: "old", title: "Free desk", price: "$0" }, { id: "new", title: "Free monitor", price: "$0", location: "Churchville" }] }));
    await saveFreeFindsReview(directory, "new", { status: "Interested", pickupNotes: "Ask about curb pickup", pickupAt: "2026-10-14T10:00", notes: "Manual lead" });
    const view = await loadFreeFindsListings(directory, new Date("2026-10-13T03:00:00Z"));
    assert.equal(view.runAt, "2026-10-13T02:00:00.000Z");
    assert.equal(view.listings.find((item) => item.id === "new")?.changeType, "new");
    assert.equal(view.listings.find((item) => item.id === "new")?.review.status, "Interested");
    assert.equal(view.listings.find((item) => item.id === "old")?.changeType, "unchanged");
    await writeFile(join(directory, "free-finds-report-2026-10-13T03-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-13T03:00:00.000Z", previousRunAt: "2026-10-13T02:00:00.000Z", errors: [], rawListings: [{ id: "old", title: "Free desk", price: "$0" }, { id: "new", title: "Free monitor", price: "$0", location: "Churchville" }] }));
    const afterNextRun = await loadFreeFindsListings(directory, new Date("2026-10-13T04:00:00Z"));
    const reviewed = afterNextRun.listings.find((item) => item.id === "new")!;
    assert.equal(reviewed.review.status, "Interested");
    assert.equal(matchesFreeFindsTriage(reviewed, "new_unreviewed"), false);
    assert.equal(matchesFreeFindsTriage(reviewed, "all"), true);
    assert.equal(matchesFreeFindsTriage({ ...reviewed, review: { ...reviewed.review, status: "Unreviewed" }, historyPresence: "new" }, "new_unreviewed"), true);
    assert.equal(matchesFreeFindsTriage({ ...reviewed, review: { ...reviewed.review, status: "Unreviewed" }, historyPresence: "reappeared" }, "attention_unreviewed"), true);
    assert.equal(matchesFreeFindsTriage({ ...reviewed, review: { ...reviewed.review, status: "Unreviewed" }, historyPresence: "repeat", changeType: "updated" }, "attention_unreviewed"), true);
    assert.equal(matchesFreeFindsTriage({ ...reviewed, review: { ...reviewed.review, status: "Interested" }, historyPresence: "reappeared" }, "attention_unreviewed"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Free Finds run history deduplicates stable IDs and reports new/changed listings without guessing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free-finds-history-"));
  try {
    await writeFile(join(directory, "free-finds-report-2026-10-13T01-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-13T01:00:00.000Z", previousRunAt: null, errors: [], rawListings: [{ id: "same", title: "Free monitor", price: "Free", location: "Churchville, MD" }, { id: "same", title: "duplicate", price: "Free", location: "Churchville, MD" }] }));
    await writeFile(join(directory, "free-finds-report-2026-10-13T02-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-13T02:00:00.000Z", previousRunAt: "2026-10-13T01:00:00.000Z", errors: [], rawListings: [{ id: "same", title: "Free monitor", price: "$0", location: "Baltimore, MD" }, { id: "new", title: "Free keyboard", price: "Free", location: "Churchville, MD" }] }));
    const history = await loadFreeFindsRunHistory(directory, new Date("2026-10-13T03:00:00Z"));
    assert.deepEqual(history[0].newIds, ["new"]);
    assert.deepEqual(history[0].updatedIds, ["same"]);
    assert.equal(history[0].changes.same[0].field, "price");
    assert.equal(history[0].comparisonSource, "free-finds-report-2026-10-13T01-00-00-000Z.json");
    assert.equal(history[0].duplicateCount, 0);
    const firstRun = history.find((run) => run.name === "free-finds-report-2026-10-13T01-00-00-000Z.json")!;
    assert.equal(firstRun.duplicateCount, 1);
    assert.match(firstRun.warnings.join(" "), /duplicate listing ID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Free Finds marks duplicate status unavailable when no readable listing snapshot exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free-finds-no-snapshot-"));
  try {
    await writeFile(join(directory, "free-finds-report-2026-10-13T03-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-13T03:00:00.000Z", errors: [] }));
    const history = await loadFreeFindsRunHistory(directory, new Date("2026-10-13T04:00:00Z"));
    assert.equal(history[0].listingCount, null);
    assert.equal(history[0].duplicateCount, 0);
    assert.match(history[0].warnings.join(" "), /snapshot is unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Free Finds exposes a price signal without claiming that any listing is confirmed free", async () => {
  assert.equal(classifyFreeFindsPrice("$0"), "listed_at_zero");
  assert.equal(classifyFreeFindsPrice("Free"), "listed_as_free");
  assert.equal(classifyFreeFindsPrice("$5"), "other_price");
  assert.equal(classifyFreeFindsPrice(undefined), "price_unavailable");
  const directory = await mkdtemp(join(tmpdir(), "free-finds-price-signal-"));
  try {
    await writeFile(join(directory, "free-finds-report-2026-10-14T01-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-14T01:00:00.000Z", errors: [], rawListings: [{ id: "zero", title: "Zero", price: "$0" }, { id: "free", title: "Free", price: "Free" }] }));
    const view = await loadFreeFindsListings(directory, new Date("2026-10-14T02:00:00.000Z"));
    assert.equal(view.listings.find((item) => item.id === "zero")?.priceSignal, "listed_at_zero");
    assert.equal(view.listings.find((item) => item.id === "free")?.priceSignal, "listed_as_free");
    assert.equal((view.listings.find((item) => item.id === "zero") as any).freeConfirmed, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Free Finds marks items new, repeated, or reappeared across retained reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free-finds-history-presence-"));
  try {
    await writeFile(join(directory, "free-finds-report-2026-10-14T01-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-14T01:00:00.000Z", errors: [], rawListings: [{ id: "old", title: "Old", price: "$0" }] }));
    await writeFile(join(directory, "free-finds-report-2026-10-14T02-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-14T02:00:00.000Z", previousRunAt: "2026-10-14T01:00:00.000Z", errors: [], rawListings: [] }));
    await writeFile(join(directory, "free-finds-report-2026-10-14T03-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-14T03:00:00.000Z", previousRunAt: "2026-10-14T02:00:00.000Z", errors: [], rawListings: [{ id: "old", title: "Old", price: "$0" }, { id: "new", title: "New", price: "Free" }] }));
    const view = await loadFreeFindsListings(directory, new Date("2026-10-14T04:00:00.000Z"));
    const old = view.listings.find((item) => item.id === "old")!;
    const fresh = view.listings.find((item) => item.id === "new")!;
    assert.equal(old.historyPresence, "reappeared");
    assert.equal(old.priorRunCount, 1);
    assert.equal(old.firstSeenRunAt, "2026-10-14T01:00:00.000Z");
    assert.equal(fresh.historyPresence, "new");
    assert.equal(fresh.priorRunCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Free Finds health distinguishes recent success, failed attempts, and stale saved results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free-finds-health-"));
  const staleDirectory = await mkdtemp(join(tmpdir(), "free-finds-stale-"));
  try {
    await writeFile(join(directory, "free-finds-report-2026-10-14T01-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-14T01:00:00.000Z", errors: [], rawListings: [{ id: "saved", title: "Saved lead", price: "$0" }] }));
    const healthy = await loadFreeFindsListings(directory, new Date("2026-10-14T02:00:00.000Z"));
    assert.equal(healthy.health.status, "healthy");
    assert.equal(healthy.health.lastAttemptAt, "2026-10-14T01:00:00.000Z");
    assert.equal(healthy.health.lastSuccessAt, "2026-10-14T01:00:00.000Z");
    assert.equal(healthy.health.resultsAreStale, false);

    await writeFile(join(directory, "free-finds-report-2026-10-14T02-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-14T02:00:00.000Z", previousRunAt: "2026-10-14T01:00:00.000Z", errors: [{ stage: "search", error: "mock timeout" }], rawListings: [] }));
    const failed = await loadFreeFindsListings(directory, new Date("2026-10-14T03:00:00.000Z"));
    assert.equal(failed.health.status, "failed");
    assert.equal(failed.health.lastAttemptAt, "2026-10-14T02:00:00.000Z");
    assert.equal(failed.health.lastSuccessAt, "2026-10-14T01:00:00.000Z");
    assert.equal(failed.health.failureReason, "mock timeout");
    assert.equal(failed.health.resultsAreStale, true);
    assert.equal(failed.runAt, "2026-10-14T01:00:00.000Z");
    assert.equal(failed.listings[0]?.id, "saved");
    assert.match(failed.message, /failed.*mock timeout.*stale/i);

    await writeFile(join(staleDirectory, "free-finds-report-2026-10-14T01-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-14T01:00:00.000Z", errors: [], rawListings: [{ id: "old", title: "Old lead", price: "$0" }] }));
    const stale = await loadFreeFindsListings(staleDirectory, new Date(Date.parse("2026-10-14T01:00:00.000Z") + FREE_FINDS_STALE_AFTER_MS + 1));
    assert.equal(stale.health.status, "stale");
    assert.equal(stale.health.staleAfterMs, FREE_FINDS_STALE_AFTER_MS);
    assert.equal(stale.health.resultsAreStale, true);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(staleDirectory, { recursive: true, force: true }); }
});

test("Free Finds health surfaces malformed saved reports without hiding the last readable results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free-finds-malformed-health-"));
  try {
    await writeFile(join(directory, "free-finds-report-2026-10-14T01-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-14T01:00:00.000Z", errors: [], rawListings: [{ id: "saved", title: "Saved lead", price: "$0" }] }));
    await writeFile(join(directory, "free-finds-report-2026-10-14T02-00-00-000Z.json"), "{not json", "utf8");

    const view = await loadFreeFindsListings(directory, new Date("2026-10-14T03:00:00.000Z"));
    assert.equal(view.health.status, "healthy");
    assert.deepEqual(view.health.malformedReports, ["free-finds-report-2026-10-14T02-00-00-000Z.json"]);
    assert.equal(view.listings[0]?.id, "saved");
    assert.match(view.message, /1 saved report is malformed/i);
    assert.match(view.issues.join(" "), /retained for diagnosis.*free-finds-report-2026-10-14T02-00-00-000Z\.json/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Free Finds distance display uses saved distance only and labels unavailable distance", () => {
  assert.equal(freeFindsDistanceLabel({ distanceKm: 12.345 }), "12.3 km");
  assert.equal(freeFindsDistanceAvailable({ distanceKm: 12.345 }), true);
  assert.equal(freeFindsDistanceLabel({ distanceLabel: "near Churchville" }), "near Churchville");
  assert.equal(freeFindsDistanceLabel({ location: "Churchville, MD" } as any), "Distance unavailable");
  assert.equal(freeFindsDistanceLabel({ distanceLabel: "distance unverified" }), "Distance unavailable");
  assert.equal(freeFindsDistanceAvailable({ distanceLabel: "distance unavailable" }), false);
});

test("Free Finds image state uses only saved HTTP(S) URLs and has a neutral missing state", async () => {
  assert.equal(normalizeFreeFindsImageUrl("https://cdn.example.test/free.jpg"), "https://cdn.example.test/free.jpg");
  assert.equal(normalizeFreeFindsImageUrl("http://cdn.example.test/free.jpg"), "http://cdn.example.test/free.jpg");
  assert.equal(normalizeFreeFindsImageUrl("javascript:alert(1)"), null);
  assert.equal(normalizeFreeFindsImageUrl("not a URL"), null);
  const directory = await mkdtemp(join(tmpdir(), "free-finds-images-"));
  try {
    await writeFile(join(directory, "free-finds-report-2026-10-13T02-00-00-000Z.json"), JSON.stringify({ runAt: "2026-10-13T02:00:00.000Z", errors: [], rawListings: [{ id: "with-image", title: "Free desk", image_url: "https://cdn.example.test/desk.jpg" }, { id: "without-image", title: "Free chair" }] }));
    const view = await loadFreeFindsListings(directory, new Date("2026-10-13T03:00:00Z"));
    assert.equal(view.listings.find((item) => item.id === "with-image")?.imageUrl, "https://cdn.example.test/desk.jpg");
    assert.equal(view.listings.find((item) => item.id === "without-image")?.imageUrl, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Free Finds query summaries count saved review/history states without implying free confirmation", () => {
  const review = (status: "Unreviewed" | "Interested") => ({ status, pickupStatus: "None" as const, pickupNotes: "", pickupAt: null, notes: "", reviewedAt: null });
  assert.deepEqual(summarizeFreeFindsListings([
    { query: " furniture ", historyPresence: "new", review: review("Unreviewed") },
    { query: "furniture", historyPresence: "repeat", review: review("Interested") },
    { query: "computers", historyPresence: "reappeared", review: review("Unreviewed") },
    { query: "", historyPresence: "new", review: review("Unreviewed") },
  ]), [
    { query: "(query unavailable)", total: 1, newCount: 1, unreviewedCount: 1, repeatedCount: 0, reappearedCount: 0 },
    { query: "computers", total: 1, newCount: 0, unreviewedCount: 1, repeatedCount: 0, reappearedCount: 1 },
    { query: "furniture", total: 2, newCount: 1, unreviewedCount: 1, repeatedCount: 1, reappearedCount: 0 },
  ]);
});

test("Free Finds query filter isolates one saved query and preserves unavailable-query diagnostics", () => {
  const items = [{ id: "a", query: "free computers" }, { id: "b", query: "free furniture" }, { id: "c" }];
  assert.deepEqual(filterFreeFindsByQuery(items, "all").map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(filterFreeFindsByQuery(items, "free furniture").map((item) => item.id), ["b"]);
  assert.deepEqual(filterFreeFindsByQuery(items, "(query unavailable)").map((item) => item.id), ["c"]);
});

test("Free Finds needs-attention summary counts saved-result review and health signals", () => {
  const review = (status: "Unreviewed" | "Interested") => ({ status, pickupStatus: "None" as const, pickupNotes: "", pickupAt: null, notes: "", reviewedAt: null });
  const items = [
    { historyPresence: "new" as const, changeType: "unchanged" as const, review: review("Unreviewed"), priceSignal: "price_unavailable" as const, distanceLabel: "Distance unavailable" },
    { historyPresence: "reappeared" as const, changeType: "updated" as const, review: review("Interested"), priceSignal: "listed_at_zero" as const, distanceKm: 3 },
    { historyPresence: "repeat" as const, changeType: "updated" as const, review: review("Unreviewed"), priceSignal: "other_price" as const, distanceKm: 4 },
  ];
  assert.deepEqual(summarizeFreeFindsAttention(items, { resultsAreStale: true, malformedReports: ["broken.json"] }), {
    newListings: 1,
    reappearedListings: 1,
    changedListings: 2,
    unreviewedListings: 2,
    staleResults: 3,
    malformedReports: 1,
    unavailableDistance: 1,
    unavailablePrice: 1,
  });
  assert.equal(summarizeFreeFindsAttention(items, { resultsAreStale: false, malformedReports: [] }).staleResults, 0);
});

test("Free Finds bulk review persists only review status for the visible filtered selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free-finds-bulk-review-"));
  try {
    await saveFreeFindsReview(directory, "visible-new", { status: "Unreviewed", pickupStatus: "Contacted", pickupNotes: "Personal note", pickupAt: "2026-10-17T14:00", notes: "Keep this" });
    await saveFreeFindsReview(directory, "hidden-old", { status: "Interested", pickupStatus: "Collected", pickupNotes: "Already collected", pickupAt: null, notes: "Do not change" });
    assert.deepEqual(selectFreeFindsBulkIds(["visible-new", "other-visible"], ["visible-new", "hidden-old"]), ["visible-new"]);
    const saved = await saveFreeFindsReviews(directory, selectFreeFindsBulkIds(["visible-new", "other-visible"], ["visible-new", "hidden-old"]), "Passed");
    assert.equal(saved.reviews["visible-new"].status, "Passed");
    assert.equal(saved.reviews["visible-new"].pickupStatus, "Contacted");
    assert.equal(saved.reviews["visible-new"].pickupNotes, "Personal note");
    assert.equal(saved.reviews["hidden-old"].status, "Interested");
    assert.equal(saved.reviews["hidden-old"].pickupStatus, "Collected");
    assert.equal((await loadFreeFindsReviews(directory)).reviews["visible-new"].notes, "Keep this");
    await assert.rejects(() => saveFreeFindsReviews(directory, ["visible-new"], "Unreviewed"), /reviewed status/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
