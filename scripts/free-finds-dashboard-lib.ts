import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadFreeFindsReviews, type FreeFindsReview } from "./free-finds-review.js";

export type FreeFindsChange = { field: "price" | "title" | "location" | "pending/availability" | "URL"; previous: string; current: string };
export type FreeFindsRun = {
  name: string;
  runAt: string | null;
  status: "ready" | "partial" | "stale" | "empty" | "malformed";
  listingCount: number | null;
  duplicateCount: number;
  newIds: string[];
  updatedIds: string[];
  changes: Record<string, FreeFindsChange[]>;
  errors: string[];
  warnings: string[];
  comparisonSource: string | null;
};
export type FreeFindsListing = Record<string, any> & {
  id: string;
  title: string;
  query?: string;
  runAt: string | null;
  review: FreeFindsReview;
  changeType: "new" | "updated" | "unchanged" | "unknown";
  changedFields: FreeFindsChange[];
  priceSignal: "listed_at_zero" | "listed_as_free" | "other_price" | "price_unavailable";
  historyPresence: "new" | "repeat" | "reappeared";
  priorRunCount: number;
  firstSeenRunAt: string | null;
};

export const FREE_FINDS_STALE_AFTER_MS = 36 * 60 * 60 * 1_000;
export type FreeFindsHealth = {
  status: "healthy" | "failed" | "stale" | "no_success";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  failureReason: string | null;
  resultsAreStale: boolean;
  staleAfterMs: number;
  malformedReports: string[];
  message: string;
};
const STALE_AFTER_MS = FREE_FINDS_STALE_AFTER_MS;

export type FreeFindsTriageFilter = "new_unreviewed" | "attention_unreviewed" | "all";
export function matchesFreeFindsTriage(item: Pick<FreeFindsListing, "historyPresence" | "review"> & Partial<Pick<FreeFindsListing, "changeType">>, filter: FreeFindsTriageFilter): boolean {
  if (filter === "all") return true;
  if (item.review.status !== "Unreviewed") return false;
  if (filter === "new_unreviewed") return item.historyPresence === "new";
  return item.historyPresence === "new" || item.historyPresence === "reappeared" || item.changeType === "updated";
}

export type FreeFindsHistoryFilter = "all" | "new" | "reappeared" | "changed" | "repeated";
export function matchesFreeFindsHistoryFilter(item: Pick<FreeFindsListing, "historyPresence" | "changeType">, filter: FreeFindsHistoryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "changed") return item.changeType === "updated";
  return item.historyPresence === (filter === "repeated" ? "repeat" : filter);
}

export function freeFindsDistanceLabel(item: { distanceKm?: unknown; distanceLabel?: unknown }): string {
  if (typeof item.distanceKm === "number" && Number.isFinite(item.distanceKm)) return `${item.distanceKm.toFixed(1)} km`;
  if (typeof item.distanceLabel === "string" && item.distanceLabel.trim() && !/unavailable|unverified/i.test(item.distanceLabel)) return item.distanceLabel;
  return "Distance unavailable";
}

export function freeFindsDistanceAvailable(item: { distanceKm?: unknown; distanceLabel?: unknown }): boolean {
  return freeFindsDistanceLabel(item) !== "Distance unavailable";
}

export function normalizeFreeFindsImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export type FreeFindsQuerySummary = {
  query: string;
  total: number;
  newCount: number;
  unreviewedCount: number;
  repeatedCount: number;
  reappearedCount: number;
};

export type FreeFindsAttentionSummary = {
  newListings: number;
  reappearedListings: number;
  changedListings: number;
  unreviewedListings: number;
  staleResults: number;
  malformedReports: number;
  unavailableDistance: number;
  unavailablePrice: number;
};

export function summarizeFreeFindsAttention(
  items: Array<Pick<FreeFindsListing, "historyPresence" | "changeType" | "review" | "priceSignal"> & { distanceKm?: unknown; distanceLabel?: unknown }>,
  health: Pick<FreeFindsHealth, "resultsAreStale" | "malformedReports">,
): FreeFindsAttentionSummary {
  return {
    newListings: items.filter((item) => item.historyPresence === "new").length,
    reappearedListings: items.filter((item) => item.historyPresence === "reappeared").length,
    changedListings: items.filter((item) => item.changeType === "updated").length,
    unreviewedListings: items.filter((item) => item.review.status === "Unreviewed").length,
    staleResults: health.resultsAreStale ? items.length : 0,
    malformedReports: health.malformedReports.length,
    unavailableDistance: items.filter((item) => !freeFindsDistanceAvailable(item)).length,
    unavailablePrice: items.filter((item) => item.priceSignal === "price_unavailable").length,
  };
}

export function summarizeFreeFindsListings(items: Array<Pick<FreeFindsListing, "query" | "historyPresence" | "review">>): FreeFindsQuerySummary[] {
  const summaries = new Map<string, FreeFindsQuerySummary>();
  for (const item of items) {
    const query = typeof item.query === "string" && item.query.trim() ? item.query.trim() : "(query unavailable)";
    const summary = summaries.get(query) ?? { query, total: 0, newCount: 0, unreviewedCount: 0, repeatedCount: 0, reappearedCount: 0 };
    summary.total += 1;
    if (item.historyPresence === "new") summary.newCount += 1;
    if (item.review.status === "Unreviewed") summary.unreviewedCount += 1;
    if (item.historyPresence === "repeat") summary.repeatedCount += 1;
    if (item.historyPresence === "reappeared") summary.reappearedCount += 1;
    summaries.set(query, summary);
  }
  return [...summaries.values()].sort((a, b) => a.query.localeCompare(b.query));
}

export function filterFreeFindsByQuery<T extends { query?: unknown }>(items: T[], query: string): T[] {
  if (query === "all") return items;
  if (query === "(query unavailable)") return items.filter((item) => typeof item.query !== "string" || !item.query.trim());
  return items.filter((item) => typeof item.query === "string" && item.query.trim() === query);
}

export function selectFreeFindsBulkIds(visibleIds: string[], selectedIds: Iterable<string>): string[] {
  const selected = new Set(selectedIds);
  return [...new Set(visibleIds.filter((id) => selected.has(id)))];
}
const isRecord = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const errors = (value: unknown): string[] => Array.isArray(value) ? value.map((x) => isRecord(x) ? String(x.error ?? "Search error") : String(x)) : [];
const listings = (value: Record<string, any>): Record<string, any>[] => { const raw = Array.isArray(value.rawListings) ? value.rawListings : Array.isArray(value.newListings) ? value.newListings : []; const seen = new Set<string>(); return raw.filter((x) => isRecord(x) && typeof x.id === "string" && !seen.has(x.id) && seen.add(x.id)); };
const duplicateCount = (value: Record<string, any>): number => { const raw = Array.isArray(value.rawListings) ? value.rawListings : Array.isArray(value.newListings) ? value.newListings : []; const seen = new Set<string>(); return raw.reduce((count, item) => { if (!isRecord(item) || typeof item.id !== "string") return count; if (seen.has(item.id)) return count + 1; seen.add(item.id); return count; }, 0); };
const display = (value: unknown): string => value === undefined || value === null || value === "" ? "(unavailable)" : String(value);

export function classifyFreeFindsPrice(value: unknown): FreeFindsListing["priceSignal"] {
  if (typeof value === "number") return value === 0 ? "listed_at_zero" : "other_price";
  if (typeof value !== "string" || !value.trim()) return "price_unavailable";
  const normalized = value.trim().toLowerCase().replace(/,/g, "");
  if (/^(?:\$\s*)?0(?:\.0{1,2})?$/.test(normalized)) return "listed_at_zero";
  if (/^(?:free|no cost|no charge)$/.test(normalized)) return "listed_as_free";
  if (/^(?:\$\s*)?\d+(?:\.\d{1,2})?$/.test(normalized)) return "other_price";
  return "price_unavailable";
}

export function freeFindsPriceSignalLabel(signal: FreeFindsListing["priceSignal"]): string {
  return signal === "listed_at_zero" ? "Listed at $0" : signal === "listed_as_free" ? "Listed as free" : signal === "other_price" ? "Other price" : "Price unavailable";
}

const actionHistoryRank = (item: Pick<FreeFindsListing, "historyPresence" | "changeType">): number =>
  item.historyPresence === "new" ? 0 : item.historyPresence === "reappeared" ? 1 : item.changeType === "updated" ? 2 : 3;
const actionPriceRank = (item: Pick<FreeFindsListing, "priceSignal">): number =>
  item.priceSignal === "listed_at_zero" ? 0 : item.priceSignal === "listed_as_free" ? 1 : item.priceSignal === "other_price" ? 2 : 3;

/** Sort saved results for review urgency; this is not a valuation or free-status ranking. */
export function compareFreeFindsActionPriority(
  a: Pick<FreeFindsListing, "review" | "historyPresence" | "changeType" | "priceSignal" | "distanceKm" | "runAt">,
  b: Pick<FreeFindsListing, "review" | "historyPresence" | "changeType" | "priceSignal" | "distanceKm" | "runAt">,
): number {
  const reviewRank = (item: typeof a): number => item.review.status === "Unreviewed" ? 0 : 1;
  return reviewRank(a) - reviewRank(b)
    || actionHistoryRank(a) - actionHistoryRank(b)
    || actionPriceRank(a) - actionPriceRank(b)
    || (typeof a.distanceKm === "number" && Number.isFinite(a.distanceKm) ? a.distanceKm : Infinity) - (typeof b.distanceKm === "number" && Number.isFinite(b.distanceKm) ? b.distanceKm : Infinity)
    || (Date.parse(b.runAt ?? "") || 0) - (Date.parse(a.runAt ?? "") || 0);
}

function changes(previous: Record<string, any>, current: Record<string, any>): FreeFindsChange[] {
  const fields: Array<[FreeFindsChange["field"], string]> = [["price", "price"], ["title", "title"], ["location", "location"], ["pending/availability", "is_pending"], ["URL", "url"]];
  return fields.filter(([, key]) => JSON.stringify(previous[key]) !== JSON.stringify(current[key])).map(([field, key]) => ({ field, previous: field === "pending/availability" ? previous[key] === true ? "Pending" : previous[key] === false ? "Available" : display(previous[key]) : display(previous[key]), current: field === "pending/availability" ? current[key] === true ? "Pending" : current[key] === false ? "Available" : display(current[key]) : display(current[key]) }));
}

export async function loadFreeFindsRunHistory(root: string, now = new Date()): Promise<FreeFindsRun[]> {
  let names: string[];
  try { names = (await readdir(root)).filter((name) => name.startsWith("free-finds-report-") && name.endsWith(".json")); } catch { return []; }
  const reports: Array<{ name: string; data: Record<string, any>; modifiedAt: number }> = [];
  const malformed: FreeFindsRun[] = [];
  for (const name of names) {
    try { const data = JSON.parse(await readFile(join(root, name), "utf8")); if (!isRecord(data)) throw new Error("report is not an object"); reports.push({ name, data, modifiedAt: (await stat(join(root, name))).mtimeMs }); }
    catch (error) { malformed.push({ name, runAt: null, status: "malformed", listingCount: null, duplicateCount: 0, newIds: [], updatedIds: [], changes: {}, errors: [], warnings: [error instanceof Error ? error.message : String(error)], comparisonSource: null }); }
  }
  reports.sort((a, b) => (Date.parse(String(b.data.runAt ?? "")) || 0) - (Date.parse(String(a.data.runAt ?? "")) || 0) || b.modifiedAt - a.modifiedAt);
  return [...reports.map((report, index) => {
    const runAt = timestamp(report.data.runAt); const priorAt = timestamp(report.data.previousRunAt); const prior = priorAt ? reports.find((candidate) => timestamp(candidate.data.runAt) === priorAt) : null; const current = listings(report.data); const duplicates = duplicateCount(report.data); const before = prior ? new Map(listings(prior.data).map((x) => [x.id, x])) : new Map<string, Record<string, any>>(); const newIds = prior ? current.filter((x) => !before.has(x.id)).map((x) => x.id) : []; const updatedIds = prior ? current.filter((x) => before.has(x.id) && changes(before.get(x.id)!, x).length).map((x) => x.id) : []; const changeMap: Record<string, FreeFindsChange[]> = {}; for (const id of updatedIds) changeMap[id] = changes(before.get(id)!, current.find((x) => x.id === id)!); const runErrors = errors(report.data.errors); const warnings: string[] = []; if (!runAt) warnings.push("Run timestamp is missing or invalid."); if (!Array.isArray(report.data.rawListings) && !Array.isArray(report.data.newListings)) warnings.push("Listing snapshot is unavailable; new/changed IDs cannot be identified."); if (priorAt && !prior) warnings.push(`The recorded comparison report ${priorAt} is missing.`); if (duplicates) warnings.push(`${duplicates} duplicate listing ID${duplicates === 1 ? "" : "s"} were collapsed for saved-result comparison.`); const stale = !runAt || now.getTime() - Date.parse(runAt) > STALE_AFTER_MS; return { name: report.name, runAt, status: stale ? "stale" : runErrors.length ? "partial" : current.length ? "ready" : "empty", listingCount: Array.isArray(report.data.rawListings) || Array.isArray(report.data.newListings) ? current.length : null, duplicateCount: duplicates, newIds, updatedIds, changes: changeMap, errors: runErrors, warnings, comparisonSource: prior?.name ?? null };
  }), ...malformed];
}

function freeFindsHealthMessage(status: FreeFindsHealth["status"], lastAttemptAt: string | null, lastSuccessAt: string | null, failureReason: string | null): string {
  if (status === "healthy") return `Healthy recent Free Finds search. Last success: ${lastSuccessAt}.`;
  if (status === "failed") return `Latest Free Finds search failed at ${lastAttemptAt ?? "(unknown time)"}${failureReason ? `: ${failureReason}` : "."} Showing the last successful results as stale.`;
  if (status === "stale") return `Free Finds results are stale: no successful search in the last 36 hours. Last success: ${lastSuccessAt ?? "(none)"}.`;
  return "No successful Free Finds search is available; saved results are not current.";
}

export async function loadFreeFindsListings(root: string, now = new Date()): Promise<{ listings: FreeFindsListing[]; runAt: string | null; status: FreeFindsRun["status"]; message: string; issues: string[]; health: FreeFindsHealth }> {
  const history = await loadFreeFindsRunHistory(root, now);
  const malformedReports = history.filter((run) => run.status === "malformed").map((run) => run.name);
  const latestAttempt = history.find((run) => run.status !== "malformed");
  const lastSuccess = history.find((run) => (run.status === "ready" || run.status === "empty" || run.status === "stale") && run.errors.length === 0);
  const failureReason = latestAttempt?.errors[0] ?? null;
  const successIsRecent = Boolean(lastSuccess?.runAt && now.getTime() - Date.parse(lastSuccess.runAt) <= FREE_FINDS_STALE_AFTER_MS);
  const healthStatus: FreeFindsHealth["status"] = !lastSuccess ? "no_success" : latestAttempt && latestAttempt.errors.length ? "failed" : successIsRecent ? "healthy" : "stale";
  const malformedMessage = malformedReports.length ? ` ${malformedReports.length} saved report${malformedReports.length === 1 ? " is" : "s are"} malformed and was retained for diagnosis.` : "";
  const health: FreeFindsHealth = { status: healthStatus, lastAttemptAt: latestAttempt?.runAt ?? null, lastSuccessAt: lastSuccess?.runAt ?? null, failureReason, resultsAreStale: healthStatus !== "healthy", staleAfterMs: FREE_FINDS_STALE_AFTER_MS, malformedReports, message: freeFindsHealthMessage(healthStatus, latestAttempt?.runAt ?? null, lastSuccess?.runAt ?? null, failureReason) + malformedMessage };
  const malformedIssues = malformedReports.map((name) => `Malformed Free Finds report retained for diagnosis: ${name}.`);
  if (!latestAttempt || !lastSuccess) return { listings: [], runAt: null, status: history.length ? "malformed" : "empty", message: health.message, issues: history.flatMap((run) => run.warnings).concat(malformedIssues, failureReason ?? []), health };
  const latest = lastSuccess;
  let data: Record<string, any>;
  try { data = JSON.parse(await readFile(join(root, latest.name), "utf8")) as Record<string, any>; }
  catch { return { listings: [], runAt: latest.runAt, status: "malformed", message: health.message, issues: ["The last successful Free Finds report could not be read."], health: { ...health, status: "no_success", resultsAreStale: true, message: "No readable successful Free Finds report is available; saved results are not current." } }; }
  const current = listings(data);
  const prior = latest.comparisonSource ? history.find((run) => run.name === latest.comparisonSource) : undefined;
  let priorData: Record<string, any> | null = null;
  if (prior) { try { priorData = JSON.parse(await readFile(join(root, prior.name), "utf8")) as Record<string, any>; } catch { /* history already reports this */ } }
  const before = priorData ? new Map(listings(priorData).map((item) => [item.id, item])) : null;
  const priorPresence = new Map<string, { count: number; firstSeenRunAt: string | null }>();
  for (const priorRun of history.slice(1)) {
    if (priorRun.status === "malformed") continue;
    try {
      const priorValue = JSON.parse(await readFile(join(root, priorRun.name), "utf8")) as Record<string, any>;
      for (const item of listings(priorValue)) {
        const existing = priorPresence.get(item.id);
        priorPresence.set(item.id, { count: (existing?.count ?? 0) + 1, firstSeenRunAt: priorRun.runAt ?? existing?.firstSeenRunAt ?? null });
      }
    } catch { /* history already reports unreadable files */ }
  }
  const reviews = await loadFreeFindsReviews(root);
  const items = current.map((item) => {
    const changedFields = before?.has(item.id) ? changes(before.get(item.id)!, item) : [];
    const changeType: FreeFindsListing["changeType"] = !before ? "unknown" : before.has(item.id) ? (changedFields.length ? "updated" : "unchanged") : "new";
    const priceSignal = classifyFreeFindsPrice(item.price);
    const presence = priorPresence.get(item.id);
    return { ...item, imageUrl: normalizeFreeFindsImageUrl(item.image_url ?? item.imageUrl), runAt: latest.runAt, review: reviews.reviews[item.id] ?? { status: "Unreviewed", pickupStatus: "None", pickupNotes: "", pickupAt: null, notes: "", reviewedAt: null }, changeType, changedFields, priceSignal, historyPresence: presence ? (before?.has(item.id) ? "repeat" : "reappeared") : "new", priorRunCount: presence?.count ?? 0, firstSeenRunAt: presence?.firstSeenRunAt ?? latest.runAt };
  });
  return { listings: items, runAt: latest.runAt, status: latest.status, message: health.message, issues: [...latest.warnings, ...malformedIssues, ...reviews.issues, ...(failureReason ? [`Latest attempt failed: ${failureReason}`] : [])], health };
}
