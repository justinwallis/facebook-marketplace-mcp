import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REVIEW_STATUSES = ["Unreviewed", "Interested", "Verify", "Passed", "Acquired"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export type ListingReview = {
  listingId: string;
  status: ReviewStatus;
  notes: string;
  manualDetails: string;
  reviewedAt: string | null;
};

export type ReviewUndoSnapshot = Record<string, ListingReview | null>;

export type BulkReviewHistoryEntry = {
  id: string;
  createdAt: string;
  status: ReviewStatus;
  listingIds: string[];
  before: ReviewUndoSnapshot;
  after: Record<string, ListingReview>;
  undoneAt: string | null;
};

const HISTORY_FILENAME = "bulk-review-history.json";
const MAX_HISTORY_ENTRIES = 20;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const REVIEW_FILENAME = "reviews.json";

export function reviewPath(root: string): string {
  return join(root, REVIEW_FILENAME);
}

export function bulkReviewHistoryPath(root: string): string {
  return join(root, HISTORY_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function cloneReview(value: ListingReview): ListingReview {
  return { ...value };
}

function isListingReview(value: unknown, listingId: string): value is ListingReview {
  return isRecord(value)
    && value.listingId === listingId
    && REVIEW_STATUSES.includes(value.status as ReviewStatus)
    && typeof value.notes === "string"
    && typeof value.manualDetails === "string"
    && (value.reviewedAt === null || validDate(value.reviewedAt));
}

function validHistoryEntry(value: unknown): value is BulkReviewHistoryEntry {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || !validDate(value.createdAt) || !REVIEW_STATUSES.includes(value.status as ReviewStatus) || !Array.isArray(value.listingIds) || !isRecord(value.before) || !isRecord(value.after)) return false;
  const ids = value.listingIds;
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) return false;
  if (!(value.undoneAt === null || validDate(value.undoneAt))) return false;
  return ids.every((id) => {
    const before = value.before[id];
    const after = value.after[id];
    return (before === null || isListingReview(before, id)) && isListingReview(after, id);
  });
}

export async function loadBulkReviewHistory(root: string): Promise<{ entries: BulkReviewHistoryEntry[]; issues: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(bulkReviewHistoryPath(root), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], issues: [] };
    return { entries: [], issues: [`Bulk review history could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return { entries: [], issues: ["Bulk review history is malformed; no saved bulk actions were loaded."] };
  const issues: string[] = [];
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  const entries = raw.entries.filter((value, index): value is BulkReviewHistoryEntry => {
    if (!validHistoryEntry(value)) { issues.push(`Bulk review history entry ${index + 1} is malformed and was ignored.`); return false; }
    if (Date.parse(value.createdAt) < cutoff) return false;
    return true;
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_HISTORY_ENTRIES);
  return { entries, issues };
}

async function writeBulkReviewHistory(root: string, entries: BulkReviewHistoryEntry[]): Promise<void> {
  await mkdir(root, { recursive: true });
  const temporary = `${bulkReviewHistoryPath(root)}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
  await rename(temporary, bulkReviewHistoryPath(root));
}

async function appendBulkReviewHistory(root: string, entry: BulkReviewHistoryEntry): Promise<BulkReviewHistoryEntry[]> {
  const current = await loadBulkReviewHistory(root);
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  const entries = [entry, ...current.entries].filter((item) => Date.parse(item.createdAt) >= cutoff).slice(0, MAX_HISTORY_ENTRIES);
  await writeBulkReviewHistory(root, entries);
  return entries;
}

function sameReview(left: ListingReview | null | undefined, right: ListingReview | null | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export async function loadReviewState(root: string): Promise<{ reviews: Record<string, ListingReview>; issues: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(reviewPath(root), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reviews: {}, issues: [] };
    return { reviews: {}, issues: [`Review data could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const source = isRecord(raw) && isRecord(raw.reviews) ? raw.reviews : raw;
  if (!isRecord(source)) return { reviews: {}, issues: ["Review data is malformed; no saved review metadata was loaded."] };
  const reviews: Record<string, ListingReview> = {};
  const issues: string[] = [];
  for (const [listingId, value] of Object.entries(source)) {
    if (!isRecord(value) || typeof listingId !== "string" || !listingId.trim()) {
      issues.push(`Review entry ${listingId || "(unknown)"} is malformed and was ignored.`);
      continue;
    }
    const status = REVIEW_STATUSES.includes(value.status as ReviewStatus) ? value.status as ReviewStatus : "Unreviewed";
    if (status === "Unreviewed" && value.status !== undefined && value.status !== "Unreviewed") issues.push(`Review ${listingId} has an invalid status and was reset to Unreviewed.`);
    const reviewedAt = value.reviewedAt === null || value.reviewedAt === undefined ? null : validDate(value.reviewedAt) ? value.reviewedAt : null;
    if (value.reviewedAt !== null && value.reviewedAt !== undefined && reviewedAt === null) issues.push(`Review ${listingId} has an invalid reviewed date and was treated as undated.`);
    reviews[listingId] = {
      listingId,
      status,
      notes: typeof value.notes === "string" ? value.notes : "",
      manualDetails: typeof value.manualDetails === "string" ? value.manualDetails : "",
      reviewedAt,
    };
  }
  return { reviews, issues };
}

export async function saveListingReview(
  root: string,
  listingId: unknown,
  patch: { status?: unknown; notes?: unknown; manualDetails?: unknown },
): Promise<{ reviews: Record<string, ListingReview>; issues: string[] }> {
  if (typeof listingId !== "string" || !listingId.trim()) throw new Error("A listing id is required.");
  if (patch.status !== undefined && !REVIEW_STATUSES.includes(patch.status as ReviewStatus)) throw new Error("Review status is invalid.");
  if (patch.notes !== undefined && typeof patch.notes !== "string") throw new Error("Review notes must be text.");
  if (patch.manualDetails !== undefined && typeof patch.manualDetails !== "string") throw new Error("Manual details must be text.");
  if (typeof patch.notes === "string" && patch.notes.length > 5_000) throw new Error("Review notes are limited to 5,000 characters.");
  if (typeof patch.manualDetails === "string" && patch.manualDetails.length > 5_000) throw new Error("Manual details are limited to 5,000 characters.");
  const state = await loadReviewState(root);
  const previous = state.reviews[listingId] ?? { listingId, status: "Unreviewed" as const, notes: "", manualDetails: "", reviewedAt: null };
  state.reviews[listingId] = {
    listingId,
    status: (patch.status ?? previous.status) as ReviewStatus,
    notes: (patch.notes ?? previous.notes) as string,
    manualDetails: (patch.manualDetails ?? previous.manualDetails) as string,
    reviewedAt: new Date().toISOString(),
  };
  await mkdir(root, { recursive: true });
  const temporary = `${reviewPath(root)}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, reviews: state.reviews }, null, 2)}\n`, "utf8");
  await rename(temporary, reviewPath(root));
  return state;
}

async function writeReviewState(root: string, reviews: Record<string, ListingReview>): Promise<void> {
  await mkdir(root, { recursive: true });
  const temporary = `${reviewPath(root)}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, reviews }, null, 2)}\n`, "utf8");
  await rename(temporary, reviewPath(root));
}

export async function saveListingReviews(
  root: string,
  listingIds: unknown,
  status: unknown,
): Promise<{ reviews: Record<string, ListingReview>; issues: string[]; previous: ReviewUndoSnapshot; historyEntry: BulkReviewHistoryEntry; history: BulkReviewHistoryEntry[] }> {
  if (!Array.isArray(listingIds) || listingIds.length === 0 || listingIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("At least one valid listing id is required.");
  }
  if (!REVIEW_STATUSES.includes(status as ReviewStatus)) throw new Error("Review status is invalid.");
  const ids = [...new Set(listingIds as string[])];
  const state = await loadReviewState(root);
  const previous: ReviewUndoSnapshot = {};
  const now = new Date().toISOString();
  for (const listingId of ids) {
    previous[listingId] = state.reviews[listingId] ? { ...state.reviews[listingId] } : null;
    const old = state.reviews[listingId] ?? { listingId, status: "Unreviewed" as const, notes: "", manualDetails: "", reviewedAt: null };
    state.reviews[listingId] = { ...old, status: status as ReviewStatus, reviewedAt: now };
  }
  await writeReviewState(root, state.reviews);
  const after: Record<string, ListingReview> = {};
  for (const listingId of ids) after[listingId] = cloneReview(state.reviews[listingId]);
  const historyEntry: BulkReviewHistoryEntry = {
    id: `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    status: status as ReviewStatus,
    listingIds: ids,
    before: previous,
    after,
    undoneAt: null,
  };
  const history = await appendBulkReviewHistory(root, historyEntry);
  return { ...state, previous, historyEntry, history };
}

export async function undoListingReviews(root: string, snapshot: unknown): Promise<{ reviews: Record<string, ListingReview>; issues: string[] }> {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("A valid bulk-review undo snapshot is required.");
  const state = await loadReviewState(root);
  for (const [listingId, value] of Object.entries(snapshot as ReviewUndoSnapshot)) {
    if (value === null) delete state.reviews[listingId];
    else if (value && typeof value === "object" && value.listingId === listingId && REVIEW_STATUSES.includes(value.status)) state.reviews[listingId] = { ...value };
    else throw new Error("The bulk-review undo snapshot is invalid.");
  }
  await writeReviewState(root, state.reviews);
  return state;
}

export async function undoBulkReview(root: string, historyId: unknown): Promise<{ reviews: Record<string, ListingReview>; issues: string[]; history: BulkReviewHistoryEntry[] }> {
  if (typeof historyId !== "string" || !historyId.trim()) throw new Error("A bulk review history id is required.");
  const historyState = await loadBulkReviewHistory(root);
  const entry = historyState.entries.find((item) => item.id === historyId);
  if (!entry) throw new Error("That bulk review action is not available; it may have expired or been removed.");
  if (entry.undoneAt) throw new Error("That bulk review action has already been undone.");
  const state = await loadReviewState(root);
  const conflicts = entry.listingIds.filter((listingId) => !sameReview(state.reviews[listingId], entry.after[listingId]));
  if (conflicts.length) throw new Error(`Cannot undo bulk review ${entry.id}: review changed since the action for listing(s): ${conflicts.join(", ")}.`);
  for (const listingId of entry.listingIds) {
    const previous = entry.before[listingId];
    if (previous === null) delete state.reviews[listingId];
    else state.reviews[listingId] = cloneReview(previous);
  }
  await writeReviewState(root, state.reviews);
  const updatedEntries = historyState.entries.map((item) => item.id === entry.id ? { ...item, undoneAt: new Date().toISOString() } : item);
  await writeBulkReviewHistory(root, updatedEntries);
  return { ...state, history: updatedEntries };
}
