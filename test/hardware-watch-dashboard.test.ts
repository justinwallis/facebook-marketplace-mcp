import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildManualReviewChecklist, loadDashboardData, loadHistoricalRun, loadRunHistory, matchesTriageFilter, normalizeImageUrl } from "../scripts/hardware-watch-dashboard-lib.js";
import { bulkReviewHistoryPath, loadBulkReviewHistory, loadReviewState, saveListingReview, saveListingReviews, undoBulkReview, undoListingReviews } from "../scripts/hardware-watch-review.js";

async function fixture(report: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-dashboard-"));
  await writeFile(join(directory, "report-2026-10-13T02-14-40-375Z.json"), JSON.stringify(report));
  return directory;
}

async function reportSet(reports: Array<{ name: string; report: unknown }>) {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-dashboard-history-"));
  for (const entry of reports) await writeFile(join(directory, entry.name), JSON.stringify(entry.report));
  return directory;
}

function historyListing(id: string, overrides: Record<string, unknown> = {}) {
  return { id, title: "Mac Studio M2 Max 96GB 1TB", price: "$1,600", location: "Baltimore, MD", url: `https://example.test/${id}`, kind: "mac", is_pending: false, posted_date: "2026-10-13T00:00:00Z", ...overrides };
}

test("loads verified candidates and keeps diagnostics separate", async () => {
  const directory = await fixture({
    runAt: "2026-10-13T02:14:40.375Z",
    errors: [],
    newListings: [{ id: "near", title: "M2 Max Mac Studio 96GB", price: "$1,600", location: "Baltimore, MD", url: "https://example.test/near", kind: "mac", distanceStatus: "in_radius", distanceKm: 43.2, distanceLabel: "43.2 km from Churchville", score: 10, isCandidate: true, exclusionReason: "Matches target" }],
    rawListings: [{ id: "far", title: "Mac Studio", price: "$1,700", location: "Los Angeles, CA", url: "https://example.test/far", kind: "mac", distanceStatus: "out_of_radius", distanceKm: 3754.1, distanceLabel: "out of radius", score: 10, isCandidate: false, exclusionReason: "out of radius" }],
  });
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T03:00:00Z"));
    assert.equal(data.status, "ready");
    assert.deepEqual(data.candidates.map((item) => item.id), ["near"]);
    assert.deepEqual(data.diagnostics.map((item) => item.id), ["far"]);
    assert.match(data.candidates[0].matchSummary, /M2 Max \+ 96 GB unified memory target/);
    assert.match(data.candidates[0].matchSummary, /Within the documented \$1,500–\$1,900 Mac Studio target band/);
    assert.match(data.candidates[0].locationConfidence, /Verified in radius/);
    assert.match(data.candidates[0].nextChecks.join(" "), /working condition/);
    assert.equal(data.bestSectionTitle, "Best matches");
    assert.equal(data.newSinceLastRun.status, "first_run");
    assert.equal(data.newSinceLastRun.newListings.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("keeps only valid saved image URLs and exposes them without changing report facts", async () => {
  assert.equal(normalizeImageUrl("https://cdn.example.test/listing.jpg"), "https://cdn.example.test/listing.jpg");
  assert.equal(normalizeImageUrl("http://cdn.example.test/listing.jpg"), "http://cdn.example.test/listing.jpg");
  assert.equal(normalizeImageUrl("javascript:alert(1)"), null);
  assert.equal(normalizeImageUrl("not a URL"), null);
  assert.equal(normalizeImageUrl(undefined), null);
  const directory = await fixture({
    runAt: "2026-10-13T02:14:40.375Z",
    errors: [],
    rawListings: [
      { id: "with-image", title: "Mac Studio M2 Max 96GB", price: "$1,600", location: "Baltimore, MD", url: "https://example.test/with-image", kind: "mac", image_url: "https://cdn.example.test/with-image.jpg" },
      { id: "bad-image", title: "Mac Studio M2 Max 96GB", price: "$1,600", location: "Baltimore, MD", url: "https://example.test/bad-image", kind: "mac", image_url: "javascript:bad" },
    ],
  });
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T03:00:00Z"));
    assert.equal(data.candidates.find((item) => item.id === "with-image")?.imageUrl, "https://cdn.example.test/with-image.jpg");
    assert.equal(data.candidates.find((item) => item.id === "bad-image")?.imageUrl, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("summarizes saved runs, exact comparison provenance, query counts, and incomplete history", async () => {
  const directory = await reportSet([
    { name: "report-2026-10-10T02-00-00-000Z.json", report: { runAt: "2026-10-10T02:00:00.000Z", previousRunAt: null, errors: [], queries: [{ kind: "mac", query: "Mac Studio", limit: 10 }], results: [{ kind: "mac", query: "Mac Studio", count: 2 }], rawListings: [historyListing("old")] } },
    { name: "report-2026-10-13T03-00-00-000Z.json", report: { runAt: "2026-10-13T03:00:00.000Z", previousRunAt: "2026-10-10T02:00:00.000Z", errors: [{ error: "GPU query timed out" }], queries: [{ kind: "proxmox", query: "GPU workstation", limit: 10 }, { kind: "mac", query: "Mac Studio", limit: 10 }], results: [{ kind: "proxmox", query: "GPU workstation", count: 0, error: "GPU query timed out" }, { kind: "mac", query: "Mac Studio", count: 1 }], rawListings: [historyListing("current")] } },
    { name: "report-2026-10-13T04-00-00-000Z.json", report: "malformed" },
  ]);
  try {
    const history = await loadRunHistory(directory, new Date("2026-10-13T05:00:00Z"));
    assert.equal(history.length, 2);
    const latest = history.find((entry) => entry.runAt === "2026-10-13T03:00:00.000Z");
    assert.equal(latest?.status, "partial");
    assert.equal(latest?.candidateCount, 1);
    assert.equal(latest?.diagnosticCount, 0);
    assert.equal(latest?.comparisonSource, "report-2026-10-10T02-00-00-000Z.json");
    assert.equal(latest?.querySummaries[0].error, "GPU query timed out");
    assert.ok(latest?.warnings.some((warning) => /run-level errors/.test(warning)) === false);
    const old = history.find((entry) => entry.runAt === "2026-10-10T02:00:00.000Z");
    assert.equal(old?.candidateCount, 1);
    assert.equal(old?.diagnosticCount, 0);
    assert.equal(old?.comparisonSource, null);
    const selected = await loadHistoricalRun(directory, "2026-10-10T02:00:00.000Z", new Date("2026-10-13T05:00:00Z"));
    assert.equal(selected?.name, "report-2026-10-10T02-00-00-000Z.json");
    const dashboard = await loadDashboardData(directory, new Date("2026-10-13T05:00:00Z"));
    assert.equal(dashboard.runHistory.some((entry) => entry.status === "malformed"), true);
    assert.ok(dashboard.issues.some((issue) => /malformed or unreadable/.test(issue)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("marks stale and missing comparison history without inferring values", async () => {
  const directory = await reportSet([
    { name: "report-2026-10-01T02-00-00-000Z.json", report: { runAt: "2026-10-01T02:00:00.000Z", previousRunAt: "2026-09-30T02:00:00.000Z", errors: [], queries: [{ kind: "mac", query: "Mac Studio" }], results: [{ kind: "mac", count: 1 }] } },
  ]);
  try {
    const history = await loadRunHistory(directory, new Date("2026-10-13T05:00:00Z"));
    assert.equal(history[0].status, "stale");
    assert.equal(history[0].candidateCount, null);
    assert.equal(history[0].diagnosticCount, null);
    assert.ok(history[0].warnings.some((warning) => /snapshot is unavailable/.test(warning)));
    assert.ok(history[0].warnings.some((warning) => /comparison report/.test(warning)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reports no changes when the referenced saved snapshot has the same listing fields", async () => {
  const directory = await reportSet([
    { name: "report-2026-10-13T02-00-00-000Z.json", report: { runAt: "2026-10-13T02:00:00.000Z", previousRunAt: null, errors: [], rawListings: [historyListing("same")] } },
    { name: "report-2026-10-13T03-00-00-000Z.json", report: { runAt: "2026-10-13T03:00:00.000Z", previousRunAt: "2026-10-13T02:00:00.000Z", errors: [], rawListings: [historyListing("same")] } },
  ]);
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T04:00:00Z"));
    assert.equal(data.newSinceLastRun.status, "no_change");
    assert.deepEqual(data.newSinceLastRun.newListings, []);
    assert.deepEqual(data.newSinceLastRun.updatedListings, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("separates new listings from updated listings by stable ID and preserves review status", async () => {
  const directory = await reportSet([
    { name: "report-2026-10-13T02-00-00-000Z.json", report: { runAt: "2026-10-13T02:00:00.000Z", previousRunAt: null, errors: [], rawListings: [historyListing("existing")] } },
    { name: "report-2026-10-13T03-00-00-000Z.json", report: { runAt: "2026-10-13T03:00:00.000Z", previousRunAt: "2026-10-13T02:00:00.000Z", errors: [], rawListings: [historyListing("existing", { price: "$1,550", location: "Columbia, Maryland", is_pending: true }), historyListing("new")] } },
  ]);
  try {
    await saveListingReview(directory, "new", { status: "Interested", notes: "history fixture", manualDetails: "" });
    const data = await loadDashboardData(directory, new Date("2026-10-13T04:00:00Z"));
    assert.equal(data.newSinceLastRun.status, "available");
    assert.deepEqual(data.newSinceLastRun.newListings.map((item) => item.id), ["new"]);
    assert.deepEqual(data.newSinceLastRun.updatedListings.map((item) => item.id), ["existing"]);
    assert.match(data.newSinceLastRun.updatedListings[0].changeSummary, /price, location, pending\/availability/);
    assert.deepEqual(data.newSinceLastRun.updatedListings[0].fieldChanges.map((change) => [change.field, change.previous, change.current, change.kind]), [
      ["price", "$1,600", "$1,550", "price_decrease"],
      ["location", "Baltimore, MD", "Columbia, Maryland", "changed"],
      ["pending/availability", "Available", "Pending", "availability"],
    ]);
    assert.equal(data.newSinceLastRun.newListings[0].reviewStatus, "Interested");
    assert.equal(data.newSinceLastRun.runAt, "2026-10-13T03:00:00.000Z");
    assert.equal(data.newSinceLastRun.previousRunAt, "2026-10-13T02:00:00.000Z");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shows field-by-field price increases, title, seller, posted date, URL, and availability changes", async () => {
  const directory = await reportSet([
    { name: "report-2026-10-13T02-00-00-000Z.json", report: { runAt: "2026-10-13T02:00:00.000Z", previousRunAt: null, errors: [], rawListings: [historyListing("changed", { seller_name: "Old seller", posted_date: "2026-10-12T00:00:00Z" }), historyListing("available", { is_pending: true })] } },
    { name: "report-2026-10-13T03-00-00-000Z.json", report: { runAt: "2026-10-13T03:00:00.000Z", previousRunAt: "2026-10-13T02:00:00.000Z", errors: [], rawListings: [historyListing("changed", { title: "Mac Studio M2 Max 96GB 2TB", price: "$1,800", seller_name: "New seller", posted_date: "2026-10-13T01:00:00Z", url: "https://example.test/changed-new" }), historyListing("available", { is_pending: false })] } },
  ]);
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T04:00:00Z"));
    const changed = data.newSinceLastRun.updatedListings.find((item) => item.id === "changed");
    const available = data.newSinceLastRun.updatedListings.find((item) => item.id === "available");
    assert.deepEqual(changed?.fieldChanges.map((change) => [change.field, change.kind]), [
      ["title", "changed"], ["price", "price_increase"], ["URL", "changed"], ["posted date", "changed"], ["seller", "changed"],
    ]);
    assert.deepEqual(available?.fieldChanges.map((change) => [change.field, change.previous, change.current, change.kind]), [["pending/availability", "Pending", "Available", "availability"]]);
    assert.equal(available?.changePriority, 1, "newly available listings sort before ordinary updates");
    assert.equal(changed?.changePriority, 3, "price increases sort after availability changes");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("labels missing previous values instead of treating them as unchanged", async () => {
  const directory = await reportSet([
    { name: "report-2026-10-13T02-00-00-000Z.json", report: { runAt: "2026-10-13T02:00:00.000Z", previousRunAt: null, errors: [], rawListings: [{ id: "partial", title: "Mac Studio M2 Max 96GB 1TB", kind: "mac" }] } },
    { name: "report-2026-10-13T03-00-00-000Z.json", report: { runAt: "2026-10-13T03:00:00.000Z", previousRunAt: "2026-10-13T02:00:00.000Z", errors: [], rawListings: [historyListing("partial", { seller_name: "Seller", posted_date: "2026-10-13T00:00:00Z", is_pending: false })] } },
  ]);
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T04:00:00Z"));
    const changes = data.newSinceLastRun.updatedListings[0].fieldChanges;
    assert.equal(changes.find((change) => change.field === "seller")?.previous, "(unavailable)");
    assert.equal(changes.find((change) => change.field === "posted date")?.previous, "(unavailable)");
    assert.equal(changes.find((change) => change.field === "pending/availability")?.previous, "(unavailable)");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("deduplicates repeated IDs within a saved report before change classification", async () => {
  const directory = await reportSet([
    { name: "report-2026-10-13T02-00-00-000Z.json", report: { runAt: "2026-10-13T02:00:00.000Z", previousRunAt: null, errors: [], rawListings: [] } },
    { name: "report-2026-10-13T03-00-00-000Z.json", report: { runAt: "2026-10-13T03:00:00.000Z", previousRunAt: "2026-10-13T02:00:00.000Z", errors: [], rawListings: [historyListing("dup"), historyListing("dup", { price: "$1,200" })] } },
  ]);
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T04:00:00Z"));
    assert.equal(data.newSinceLastRun.newListings.length, 1);
    assert.equal(data.newSinceLastRun.updatedListings.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("does not claim change history when the referenced prior report is missing", async () => {
  const directory = await fixture({ runAt: "2026-10-13T03:00:00.000Z", previousRunAt: "2026-10-13T02:00:00.000Z", errors: [], rawListings: [historyListing("missing-history")] });
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T04:00:00Z"));
    assert.equal(data.newSinceLastRun.status, "missing_history");
    assert.match(data.newSinceLastRun.message, /previous report is not available/);
    assert.deepEqual(data.newSinceLastRun.newListings, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("marks change history stale when the latest saved report is stale", async () => {
  const directory = await reportSet([
    { name: "report-2026-10-10T02-00-00-000Z.json", report: { runAt: "2026-10-10T02:00:00.000Z", previousRunAt: null, errors: [], rawListings: [historyListing("old")] } },
    { name: "report-2026-10-11T02-00-00-000Z.json", report: { runAt: "2026-10-11T02:00:00.000Z", previousRunAt: "2026-10-10T02:00:00.000Z", errors: [], rawListings: [historyListing("old"), historyListing("stale-new")] } },
  ]);
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T04:00:00Z"));
    assert.equal(data.status, "stale");
    assert.equal(data.newSinceLastRun.status, "stale");
    assert.match(data.newSinceLastRun.message, /stale/);
    assert.deepEqual(data.newSinceLastRun.newListings.map((item) => item.id), ["stale-new"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects MacBooks and incomplete Mac Studio specs from Best Deals", async () => {
  const directory = await fixture({
    runAt: "2026-10-13T02:14:40.375Z",
    errors: [],
    newListings: [
      { id: "macbook", title: "MacBook Pro M2 Max 96GB 1TB", price: "$1,600", location: "Baltimore, MD", url: "https://example.test/macbook", kind: "mac", distanceStatus: "in_radius", distanceKm: 43, isCandidate: true },
      { id: "missing-memory", title: "Mac Studio M2 Max 32GB 1TB", price: "$1,600", location: "Baltimore, MD", url: "https://example.test/missing", kind: "mac", distanceStatus: "in_radius", distanceKm: 43, isCandidate: true },
      { id: "good", title: "Mac Studio M2 Max 96GB 1TB", price: "$1,600", location: "Baltimore, MD", url: "https://example.test/good", kind: "mac", distanceStatus: "in_radius", distanceKm: 43, isCandidate: true },
    ],
  });
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T03:00:00Z"));
    assert.deepEqual(data.candidates.map((item) => item.id), ["good"]);
    assert.match(data.diagnostics.find((item) => item.id === "macbook")?.matchSummary ?? "", /MacBook, not a Mac Studio/);
    assert.deepEqual(data.diagnostics.find((item) => item.id === "missing-memory")?.missingSpecs, ["96 GB unified memory"]);
    assert.match(data.diagnostics.find((item) => item.id === "missing-memory")?.matchSummary ?? "", /Possible lead — needs verification/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("keeps out-of-area and unknown-distance listings diagnostic and separates Proxmox deals", async () => {
  const directory = await fixture({
    runAt: "2026-10-13T02:14:40.375Z",
    errors: [],
    newListings: [
      { id: "proxmox", title: "Dell OptiPlex 7000 i7-12700 32GB DDR5 512GB SSD", price: "$350", location: "Baltimore, MD", url: "https://example.test/proxmox", kind: "proxmox", distanceStatus: "in_radius", distanceKm: 43, isCandidate: true },
      { id: "far", title: "Mac Studio M2 Max 96GB 1TB", price: "$1,600", location: "Los Angeles, CA", url: "https://example.test/far", kind: "mac", distanceStatus: "out_of_radius", distanceKm: 3754, isCandidate: true },
      { id: "unknown", title: "Mac Studio M2 Max 96GB 1TB", price: "$1,600", location: "Unknown", url: "https://example.test/unknown", kind: "mac", isCandidate: true },
    ],
  });
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T03:00:00Z"));
    assert.deepEqual(data.candidates.map((item) => item.category), ["Proxmox"]);
    assert.equal(data.diagnostics.find((item) => item.id === "far")?.distanceStatus, "out_of_radius");
    assert.equal(data.diagnostics.find((item) => item.id === "unknown")?.distanceStatus, "unverified");
    assert.match(data.diagnostics.find((item) => item.id === "far")?.matchSummary ?? "", /outside the 80 km radius/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recomputes saved report distance instead of trusting stale distanceStatus", async () => {
  const directory = await fixture({
    runAt: "2026-10-13T09:56:08.838Z",
    errors: [],
    rawListings: [
      { id: "saved-near", title: "Mac Studio M2 Max 96GB 1TB", price: "$1,600", location: "Baltimore, Maryland", url: "https://example.test/saved-near", kind: "mac", distanceStatus: "unverified", distanceKm: null },
      { id: "saved-far", title: "Mac Studio M2 Max 96GB 1TB", price: "$1,600", location: "Citrus Heights, California", url: "https://example.test/saved-far", kind: "mac", distanceStatus: "unverified", distanceKm: null },
    ],
  });
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T10:00:00Z"));
    assert.equal(data.candidates.map((item) => item.id).join(), "saved-near");
    assert.equal(data.diagnostics.find((item) => item.id === "saved-far")?.distanceStatus, "out_of_radius");
    assert.equal(data.diagnostics.find((item) => item.id === "saved-near"), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("groups real Proxmox leads without implying every system is complete", async () => {
  const directory = await fixture({
    runAt: "2026-10-13T09:56:08.838Z",
    errors: [],
    rawListings: [
      { id: "xps-9520", title: "Dell xps 9520. I7 12700h, 512gb ssd, 16gb ram, 4k OLED touch screen rtx 3050", price: "$500", location: "Baltimore, Maryland", url: "https://example.test/xps", kind: "proxmox", distanceStatus: "unverified" },
      { id: "hp-z2", title: "HP Z2 G8 Gaming PC – i7-11700 | RTX 3060 12GB | 32GB RAM | 1TB NVMe", price: "$649", location: "Columbia, Maryland", url: "https://example.test/z2", kind: "proxmox", distanceStatus: "unverified" },
      { id: "precision-3620", title: "Dell Precision 3620 Workstation Core i7 24GB RAM 256GB SSD Windows 11 Pro", price: "$195", location: "Churchville, Maryland", url: "https://example.test/precision", kind: "proxmox", distanceStatus: "unverified" },
      { id: "ram-component", title: "G.Skill TridentZ RGB DDR4 RAM 8GB x4 sticks", price: "$140", location: "Columbia, Maryland", url: "https://example.test/ram", kind: "proxmox", distanceStatus: "unverified" },
    ],
  });
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T10:00:00Z"));
    const hp = data.candidates.find((item) => item.id === "hp-z2");
    assert.equal(hp?.proxmoxGroup, "complete_computer");
    assert.match(hp?.proxmoxBuildFit ?? "", /Complete computer candidate/);
    assert.match(hp?.proxmoxBuildFit ?? "", /128 GB RAM target/);
    assert.match(hp?.proxmoxBuildFit ?? "", /working condition and final component compatibility/);
    assert.match(hp?.priceAssessment ?? "", /Asking price is below/);
    assert.match(hp?.priceAssessment ?? "", /total build cost is unknown/);
    assert.deepEqual(hp?.additionalParts, [
      "At least 96 GB more RAM capacity to reach the 128 GB target; module compatibility is unverified",
      "Working-condition and platform-compatibility checks are still needed",
      "Any omitted build components and their prices are unknown",
    ]);
    assert.match(hp?.totalBuildCost ?? "", /Unknown/);
    assert.deepEqual(hp?.nextChecks, [
      "Confirm working condition",
      "Verify CPU, motherboard, RAM, storage, and stated GPU compatibility for the planned Proxmox build",
      "Confirm whether the 128 GB RAM target can be met",
    ]);
    assert.equal(data.candidates.find((item) => item.id === "ram-component")?.proxmoxGroup, "component");
    assert.deepEqual(data.candidates.find((item) => item.id === "ram-component")?.nextChecks, [
      "Confirm the component is tested and in working condition",
      "Verify compatibility with the selected CPU, motherboard, RAM type, and storage platform",
    ]);
    assert.equal(data.diagnostics.find((item) => item.id === "xps-9520")?.proxmoxGroup, "incomplete_system");
    assert.match(data.diagnostics.find((item) => item.id === "xps-9520")?.matchSummary ?? "", /Laptop platform/);
    assert.equal(data.diagnostics.find((item) => item.id === "precision-3620")?.proxmoxGroup, "incomplete_system");
    assert.deepEqual(data.diagnostics.find((item) => item.id === "precision-3620")?.missingSpecs, ["CPU/platform not stated"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("does not confuse a complete computer with a complete Proxmox build", async () => {
  const directory = await fixture({
    runAt: "2026-10-13T09:56:08.838Z",
    errors: [],
    rawListings: [{ id: "computer", title: "HP Z2 G8 i7-11700 RTX 3060 12GB 32GB RAM 1TB NVMe", price: "$649", location: "Columbia, Maryland", url: "https://example.test/computer", kind: "proxmox" }],
  });
  try {
    const item = (await loadDashboardData(directory, new Date("2026-10-13T10:00:00Z"))).candidates[0];
    assert.equal(item.proxmoxGroup, "complete_computer");
    assert.match(item.targetFit, /Complete computer evidence/);
    assert.match(item.proxmoxBuildFit ?? "", /Complete computer candidate/);
    assert.match(item.proxmoxBuildFit ?? "", /missing\/unverified:/);
    assert.match(item.proxmoxBuildFit ?? "", /128 GB RAM target/);
    assert.match(item.matchSummary, /total build cost is unknown/);
    assert.match(item.priceAssessment, /Asking price is below/);
    assert.match(item.totalBuildCost, /not all required parts and upgrades/);
    assert.match(item.nextChecks.join(" "), /working condition/);
    assert.match(item.nextChecks.join(" "), /compatibility/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("handles an empty report explicitly", async () => {
  const directory = await fixture({ runAt: "2026-10-13T02:14:40.375Z", errors: [], newListings: [], rawListings: [] });
  try { assert.equal((await loadDashboardData(directory, new Date("2026-10-13T03:00:00Z"))).status, "empty"); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("does not crash on malformed reports or a missing directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-dashboard-"));
  await writeFile(join(directory, "report-bad.json"), "not-json");
  try {
    const malformed = await loadDashboardData(directory);
    assert.equal(malformed.status, "malformed");
    assert.equal(malformed.issues.length, 1);
    const missing = await loadDashboardData(join(directory, "missing"));
    assert.equal(missing.status, "missing");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("marks a legacy report stale and excludes legacy candidates without distance proof", async () => {
  const directory = await fixture({ runAt: "2026-10-10T02:14:40.375Z", errors: [], newListings: [{ id: "legacy", title: "Mac Studio", price: "$1,600", location: "Somewhere, ZZ", url: "https://example.test/legacy", kind: "mac" }] });
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T03:00:00Z"));
    assert.equal(data.status, "stale");
    assert.equal(data.candidates.length, 0);
    assert.equal(data.diagnostics[0]?.distanceStatus, "unverified");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("does not promote a stale qualified listing into Best matches", async () => {
  const directory = await fixture({
    runAt: "2026-10-10T02:14:40.375Z",
    errors: [],
    newListings: [{ id: "stale-good", title: "Mac Studio M2 Max 96GB 1TB", price: "$1,600", location: "Baltimore, MD", url: "https://example.test/stale-good", kind: "mac", distanceStatus: "in_radius", distanceKm: 43 }],
  });
  try {
    const data = await loadDashboardData(directory, new Date("2026-10-13T03:00:00Z"));
    assert.equal(data.status, "stale");
    assert.equal(data.candidates.length, 0);
    assert.match(data.diagnostics[0]?.matchSummary ?? "", /latest report is stale/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dashboard client bounds report loading and exposes a visible error state", async () => {
  const source = await readFile(new URL("../scripts/hardware-watch-dashboard.ts", import.meta.url), "utf8");
  assert.match(source, /AbortSignal\.timeout\(5000\)/);
  assert.match(source, /LOAD ERROR/);
  assert.match(source, /Could not load local reports/);
  assert.match(source, /New since last run/);
  assert.match(source, /newListings/);
  assert.match(source, /updatedListings/);
  assert.match(source, /No reliable previous snapshot is available/);
  assert.match(source, /changeSummary/);
  assert.match(source, /fieldChanges/);
  assert.match(source, /change-price-decrease/);
  assert.match(source, /change-price-increase/);
  assert.match(source, /changePriority/);
});

test("dashboard configuration controls remain local and cannot run the watcher", async () => {
  const source = await readFile(new URL("../scripts/hardware-watch-dashboard.ts", import.meta.url), "utf8");
  assert.match(source, /const host = "127\.0\.0\.1"/);
  assert.match(source, /pending-configuration|savePendingConfiguration/);
  assert.match(source, /APPLY_NEXT_RUN/);
  assert.match(source, /REVERT_LAST_APPLIED/);
  assert.doesNotMatch(source, /Run now/);
  assert.doesNotMatch(source, /runMcpSearches/);
});

test("configuration is rendered above Best matches and review controls remain local", async () => {
  const source = await readFile(new URL("../scripts/hardware-watch-dashboard.ts", import.meta.url), "utf8");
  assert.match(source, /data-layout-key=\"configuration\"/);
  assert.match(source, /data-layout-key=\"bestMatches\"/);
  assert.ok(source.indexOf('data-layout-key="configuration"') < source.indexOf('data-layout-key="bestMatches"'));
  assert.ok(!source.includes('replace("</main>", configPanel'));
  assert.match(source, /discardPending/);
  assert.match(source, /DISCARD_PENDING/);
  assert.match(source, /No pending configuration saved\. Active configuration remains unchanged\./);
  assert.match(source, /id="reviewStatus"/);
  assert.ok(source.includes('value=\\"review\\"') || source.includes('value="review"'));
  assert.match(source, /POST.*api\/reviews|api\/reviews.*POST/s);
  assert.doesNotMatch(source, /startWatcher|runMcpSearches|createMonitor/);
});

test("persists manual review metadata separately from report data", async () => {
  const directory = await fixture({
    runAt: "2026-10-13T02:14:40.375Z",
    errors: [],
    rawListings: [{ id: "reviewed", title: "Mac Studio M2 Max 96GB 1TB", price: "$1,600", location: "Baltimore, MD", url: "https://example.test/reviewed", kind: "mac" }],
  });
  try {
    const saved = await saveListingReview(directory, "reviewed", { status: "Interested", notes: "Check serial", manualDetails: "Physical inspection not yet done" });
    assert.equal(saved.reviews.reviewed.status, "Interested");
    assert.match(saved.reviews.reviewed.reviewedAt ?? "", /^2026|^20/);
    const loaded = await loadReviewState(directory);
    assert.equal(loaded.reviews.reviewed.notes, "Check serial");
    const data = await loadDashboardData(directory, new Date("2026-10-13T03:00:00Z"));
    assert.equal(data.candidates[0].reviewStatus, "Interested");
    assert.equal(data.candidates[0].reviewNotes, "Check serial");
    assert.equal(data.candidates[0].manualDetails, "Physical inspection not yet done");
    assert.equal(data.candidates[0].targetFit, "M2 Max + 96 GB unified memory target");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reports malformed and stale review metadata without crashing", async () => {
  const directory = await fixture({
    runAt: "2026-10-13T02:14:40.375Z",
    errors: [],
    rawListings: [{ id: "current", title: "Mac Studio M2 Max 96GB 1TB", price: "$1,600", location: "Baltimore, MD", url: "https://example.test/current", kind: "mac" }],
  });
  try {
    await writeFile(join(directory, "reviews.json"), JSON.stringify({ reviews: {
      current: { status: "not-a-status", notes: 7, reviewedAt: "not-a-date" },
      "old-listing": { status: "Passed", notes: "old", manualDetails: "", reviewedAt: "2026-10-12T00:00:00Z" },
    }}));
    const data = await loadDashboardData(directory, new Date("2026-10-13T03:00:00Z"));
    assert.equal(data.candidates[0].reviewStatus, "Unreviewed");
    assert.deepEqual(data.staleReviewIds, ["old-listing"]);
    assert.ok(data.reviewIssues.length >= 2);
    assert.ok(data.issues.some((issue) => /not present in the latest reports/.test(issue)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("combines quick triage filters with saved change fields and review status", () => {
  const changes = [{
    id: "drop",
    changeType: "updated" as const,
    changeSummary: "price",
    fieldChanges: [{ field: "price" as const, previous: "$1,700", current: "$1,500", kind: "price_decrease" as const }],
  } as any, {
    id: "available",
    changeType: "updated" as const,
    changeSummary: "availability",
    fieldChanges: [{ field: "pending/availability" as const, previous: "Pending", current: "Available", kind: "availability" as const }],
  } as any, {
    id: "new",
    changeType: "new" as const,
    changeSummary: "new",
    fieldChanges: [],
  } as any];
  assert.equal(matchesTriageFilter({ id: "drop", reviewStatus: "Verify" }, "price_drop", changes), true);
  assert.equal(matchesTriageFilter({ id: "drop", reviewStatus: "Verify" }, "Verify", changes), true);
  assert.equal(matchesTriageFilter({ id: "drop", reviewStatus: "Interested" }, "Verify", changes), false);
  assert.equal(matchesTriageFilter({ id: "available", reviewStatus: "Unreviewed" }, "newly_available", changes), true);
  assert.equal(matchesTriageFilter({ id: "new", reviewStatus: "Unreviewed" }, "new", changes), true);
  assert.equal(matchesTriageFilter({ id: "missing", reviewStatus: "Unreviewed" }, "price_drop", changes), false);
});

test("bulk review changes require explicit selection, preserve notes, and undo exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-bulk-review-"));
  try {
    await saveListingReview(directory, "keep", { status: "Interested", notes: "serial note", manualDetails: "checked label" });
    const saved = await saveListingReviews(directory, ["keep", "new", "keep"], "Passed");
    assert.equal(saved.reviews.keep.status, "Passed");
    assert.equal(saved.reviews.keep.notes, "serial note");
    assert.equal(saved.reviews.keep.manualDetails, "checked label");
    assert.equal(saved.reviews.new.status, "Passed");
    await undoListingReviews(directory, saved.previous);
    const restored = await loadReviewState(directory);
    assert.equal(restored.reviews.keep.status, "Interested");
    assert.equal(restored.reviews.keep.notes, "serial note");
    assert.equal(restored.reviews.keep.manualDetails, "checked label");
    assert.equal(restored.reviews.new, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bulk review history persists across reloads and undo restores exact selected reviews only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-persistent-bulk-"));
  try {
    await saveListingReview(directory, "selected", { status: "Interested", notes: "keep this", manualDetails: "verified label" });
    await saveListingReview(directory, "outside", { status: "Verify", notes: "outside note", manualDetails: "outside details" });
    const applied = await saveListingReviews(directory, ["selected"], "Passed");
    const reloaded = await loadBulkReviewHistory(directory);
    assert.equal(reloaded.issues.length, 0);
    assert.equal(reloaded.entries.length, 1);
    assert.equal(reloaded.entries[0].id, applied.historyEntry.id);
    assert.equal(reloaded.entries[0].after.selected.status, "Passed");
    const undone = await undoBulkReview(directory, applied.historyEntry.id);
    assert.equal(undone.reviews.selected.status, "Interested");
    assert.equal(undone.reviews.selected.notes, "keep this");
    assert.equal(undone.reviews.selected.manualDetails, "verified label");
    assert.equal(undone.reviews.outside.status, "Verify");
    assert.equal(undone.reviews.outside.notes, "outside note");
    assert.equal(undone.history[0].undoneAt !== null, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bulk review history is bounded and ignores expired entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-history-bound-"));
  try {
    for (let i = 0; i < 22; i++) await saveListingReviews(directory, [`item-${i}`], "Verify");
    const history = await loadBulkReviewHistory(directory);
    assert.equal(history.entries.length, 20);
    assert.equal(history.entries.some((entry) => entry.listingIds.includes("item-0")), false);
    const old = history.entries[0];
    await writeFile(bulkReviewHistoryPath(directory), JSON.stringify({ version: 1, entries: [{ ...old, id: "expired", createdAt: "2020-01-01T00:00:00.000Z" }] }));
    const expired = await loadBulkReviewHistory(directory);
    assert.deepEqual(expired.entries, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bulk undo detects changed reviews and leaves them untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-history-conflict-"));
  try {
    const applied = await saveListingReviews(directory, ["conflict"], "Passed");
    await saveListingReview(directory, "conflict", { status: "Interested", notes: "changed after bulk", manualDetails: "new detail" });
    await assert.rejects(() => undoBulkReview(directory, applied.historyEntry.id), /changed since the action.*conflict/);
    const current = await loadReviewState(directory);
    assert.equal(current.reviews.conflict.status, "Interested");
    assert.equal(current.reviews.conflict.notes, "changed after bulk");
    const history = await loadBulkReviewHistory(directory);
    assert.equal(history.entries[0].undoneAt, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("malformed bulk history is reported and confirmation remains explicit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hardware-watch-history-malformed-"));
  try {
    await writeFile(bulkReviewHistoryPath(directory), JSON.stringify({ version: 1, entries: [{ id: "bad", status: "Passed" }] }));
    const history = await loadBulkReviewHistory(directory);
    assert.deepEqual(history.entries, []);
    assert.match(history.issues[0], /malformed/);
    const source = await readFile(new URL("../scripts/hardware-watch-dashboard.ts", import.meta.url), "utf8");
    assert.match(source, /Explicit confirmation is required to undo a bulk review change/);
    assert.match(source, /changed since the action/);
    assert.match(source, /No persisted bulk review actions/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dashboard groups long sections, persists layout preferences, and keeps workflow state separate", async () => {
  const source = await readFile(new URL("../scripts/hardware-watch-dashboard.ts", import.meta.url), "utf8");
  for (const marker of ["data-layout-key=\"configuration\"", "data-layout-key=\"newSinceLastRun\"", "data-layout-key=\"bestMatches\"", "data-layout-key=\"diagnostics\"", "data-layout-key=\"bulkHistory\"", "data-layout-key=\"runHistory\"", "summaryCandidates", "summaryDiagnostics", "summaryNew", "summaryUpdated", "summaryFilters", "restoreLayoutDefaults", "layoutStorageKey", "localStorage.setItem", "localStorage.removeItem"]) {
    assert.ok(source.includes(marker), `missing layout marker: ${marker}`);
  }
  assert.match(source, /<details class="section-fold"/);
  assert.match(source, /<summary>New since last run/);
  assert.match(source, /<summary>Best matches/);
  assert.match(source, /<summary>Diagnostics/);
  assert.match(source, /<summary>Bulk review history/);
  assert.match(source, /Run history &amp; health/);
  assert.match(source, /historySelect/);
  assert.match(source, /Selected historical run \(read-only\)/);
  assert.match(source, /comparisonSource/);
  assert.match(source, /selectedIds/);
  assert.match(source, /reviewData/);
  assert.match(source, /name=\"viewport\"/);
  assert.match(source, /flex-wrap:wrap/);
  assert.match(source, /focus-visible/);
});

test("dashboard exposes triage controls, confirmation, undo, and local-only review endpoints", async () => {
  const source = await readFile(new URL("../scripts/hardware-watch-dashboard.ts", import.meta.url), "utf8");
  for (const marker of ["data-triage=\"new\"", "data-triage=\"price_drop\"", "data-triage=\"newly_available\"", "data-triage=\"Interested\"", "data-triage=\"Verify\"", "data-triage=\"Unreviewed\"", "Active filters:", "Reset filters", "Apply to selected", "BULK_REVIEW_CONFIRM", "UNDO_BULK_REVIEW", "Undo latest persisted bulk change"]) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /Existing notes and manual verification details will be preserved/);
  assert.doesNotMatch(source, /runMcpSearches|createMonitor/);
});

test("Free Finds is isolated, configuration/review-only, and has no hourly or Run Now path", async () => {
  const source = await readFile(new URL("../scripts/hardware-watch-dashboard.ts", import.meta.url), "utf8");
  assert.match(source, /free-finds\/config/);
  assert.match(source, /free-finds\/reviews/);
  assert.match(source, /Free Finds/);
  assert.match(source, /configuration\/review only/);
  assert.match(source, /free-finds\/readiness/);
  assert.match(source, /free-finds\/scheduler/);
  assert.match(source, /ENABLE_FREE_FINDS_HOURLY/);
  assert.match(source, /freeSchedulerStatus/);
  assert.match(source, /savedRun\.health/);
  assert.match(source, /resultsAreStale/);
  assert.match(source, /freeFindsHealthSummary/);
  assert.match(source, /last attempt/);
  assert.match(source, /last success/);
  assert.match(source, /stale after/);
  assert.match(source, /malformed saved reports/);
  assert.match(source, /Needs attention/);
  assert.match(source, /reappeared/);
  assert.match(source, /unavailableDistance/);
  assert.match(source, /unavailablePrice/);
  assert.match(source, /previewFreeFindsReadiness/);
  assert.match(source, /requestCount|resultSlots|estimated limiter wait/);
  assert.match(source, /freePriceSignal/);
  assert.match(source, /historyPresence/);
  assert.match(source, /New to retained history/);
  assert.match(source, /Reappeared after an absence/);
  assert.match(source, /freeTriageFilter/);
  assert.match(source, /new_unreviewed/);
  assert.match(source, /All saved listings/);
  assert.match(source, /Personal pickup tracking/);
  assert.match(source, /data-free-pickup-status/);
  assert.match(source, /pickupStatus/);
  assert.match(source, /freeDistanceFilter/);
  assert.match(source, /Distance available/);
  assert.match(source, /Distance unavailable/);
  assert.match(source, /freeDistanceAvailable/);
  assert.match(source, /free-finds-view-v1/);
  assert.match(source, /Reset saved Free Finds view/);
  assert.match(source, /restoreFreeFindsFilters/);
  assert.match(source, /saveFreeFindsFilters/);
  assert.match(source, /freeFindsQuerySummary/);
  assert.match(source, /Current view by saved query/);
  assert.match(source, /counts are saved listings, not confirmed-free results/);
  assert.match(source, /free-query-group/);
  assert.match(source, /freeApplyBulkReview/);
  assert.match(source, /freeBulkSelectedCount/);
  assert.match(source, /FREE_FINDS_BULK_REVIEW_CONFIRM/);
  assert.match(source, /visible Free Finds listing/);
  assert.match(source, /pickup tracking and report facts are preserved/);
  assert.match(source, /free-finds\/reviews\/bulk/);
  assert.match(source, /freeImageUrl/);
  assert.match(source, /No image available in saved report/);
  assert.match(source, /Thumbnail for/);
  assert.doesNotMatch(source, /freeConfirmed/);
  assert.doesNotMatch(source, /api\/free-finds\/run/);
  assert.doesNotMatch(source, /startWatcher|runMcpSearches/);
});

test("listing cards stay compact and disclose accessible report facts, review data, and copy-only checklists", async () => {
  const source = await readFile(new URL("../scripts/hardware-watch-dashboard.ts", import.meta.url), "utf8");
  assert.match(source, /listing-thumb/);
  assert.match(source, /loading=\\?"lazy\\?"/);
  assert.match(source, /width=\\?"96\\?".*height=\\?"72\\?"/);
  assert.match(source, /alt=\\?"Thumbnail for/);
  assert.match(source, /onerror=\\?"this\.hidden=true/);
  assert.match(source, /No thumbnail in saved report/);
  assert.match(source, /referrerpolicy=\\?"no-referrer\\?"/);
  assert.match(source, /toggleThumbnails/);
  assert.match(source, /thumbnailStorageKey/);
  assert.match(source, /<details class="listing-details" data-listing-details>/);
  assert.match(source, /<summary>Show evidence and review details<\/summary>/);
  assert.match(source, /Report facts/);
  assert.match(source, /Your review data/);
  assert.match(source, /data-copy-checklist/);
  assert.match(source, /navigator\.clipboard\?\.writeText/);
  assert.match(source, /button\.dataset\.checklist/);
  assert.match(source, /button:focus-visible.*summary:focus-visible/s);
  assert.doesNotMatch(source, /sendMessage|contactSeller|openSellerContact/);
});

test("checklist content uses only saved facts and existing missing-check evidence", () => {
  const checklist = buildManualReviewChecklist({
    title: "HP Z2 G8",
    price: "$649",
    location: "Columbia, Maryland",
    distanceLabel: "65.8 km from Churchville",
    nextChecks: ["Confirm working condition", "Confirm whether the 128 GB RAM target can be met"],
  });
  assert.match(checklist, /Listing: HP Z2 G8/);
  assert.match(checklist, /Reported price: \$649/);
  assert.match(checklist, /Confirm working condition/);
  assert.match(checklist, /128 GB RAM target/);
  assert.doesNotMatch(checklist, /contact seller|send|compatible|works/);
});
