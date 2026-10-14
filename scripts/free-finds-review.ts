import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FREE_FINDS_REVIEW_FILENAME = "free-finds-reviews.json";
export const FREE_FINDS_REVIEW_STATUSES = ["Unreviewed", "Interested", "Pickup planned", "Collected", "Passed", "Unavailable/claimed"] as const;
export const FREE_FINDS_PICKUP_STATUSES = ["None", "Interested", "Contacted", "Claimed/gone", "Collected", "No longer interested"] as const;
export type FreeFindsReviewStatus = typeof FREE_FINDS_REVIEW_STATUSES[number];
export type FreeFindsPickupStatus = typeof FREE_FINDS_PICKUP_STATUSES[number];
export type FreeFindsReview = { status: FreeFindsReviewStatus; pickupStatus: FreeFindsPickupStatus; pickupNotes: string; pickupAt: string | null; notes: string; reviewedAt: string | null };
export type FreeFindsReviewState = { reviews: Record<string, FreeFindsReview>; issues: string[] };

export function freeFindsReviewPath(root: string): string { return join(root, FREE_FINDS_REVIEW_FILENAME); }

export async function loadFreeFindsReviews(root: string): Promise<FreeFindsReviewState> {
  try {
    const value = JSON.parse(await readFile(freeFindsReviewPath(root), "utf8")) as any;
    if (!value || typeof value !== "object" || !value.reviews || typeof value.reviews !== "object") return { reviews: {}, issues: ["Free Finds review data is malformed; ignored."] };
    const reviews: Record<string, FreeFindsReview> = {};
    const issues: string[] = [];
    for (const [id, review] of Object.entries(value.reviews)) {
      if (!review || typeof review !== "object") { issues.push(`Free Finds review for ${id} is invalid; ignored.`); continue; }
      const r = review as any;
      const status = r.status === "Unavailable" ? "Unavailable/claimed" : r.status;
      if (!FREE_FINDS_REVIEW_STATUSES.includes(status)) { issues.push(`Free Finds review for ${id} is invalid; ignored.`); continue; }
      const pickupStatus = FREE_FINDS_PICKUP_STATUSES.includes(r.pickupStatus) ? r.pickupStatus : "None";
      reviews[id] = { status, pickupStatus, pickupNotes: typeof r.pickupNotes === "string" ? r.pickupNotes : "", pickupAt: typeof r.pickupAt === "string" ? r.pickupAt : null, notes: typeof r.notes === "string" ? r.notes : "", reviewedAt: typeof r.reviewedAt === "string" ? r.reviewedAt : null };
    }
    return { reviews, issues };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reviews: {}, issues: [] };
    return { reviews: {}, issues: [`Free Finds review data could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export async function saveFreeFindsReview(root: string, listingId: unknown, input: Partial<FreeFindsReview>): Promise<FreeFindsReviewState> {
  if (typeof listingId !== "string" || !listingId.trim()) throw new Error("Free Finds listing ID is required.");
  if (!FREE_FINDS_REVIEW_STATUSES.includes(input.status as FreeFindsReviewStatus)) throw new Error("Invalid Free Finds review status.");
  if (input.pickupStatus !== undefined && !FREE_FINDS_PICKUP_STATUSES.includes(input.pickupStatus as FreeFindsPickupStatus)) throw new Error("Invalid Free Finds pickup status.");
  const current = await loadFreeFindsReviews(root);
  const pickupAt = input.pickupAt === null || input.pickupAt === undefined || input.pickupAt === "" ? null : String(input.pickupAt);
  current.reviews[listingId] = { status: input.status as FreeFindsReviewStatus, pickupStatus: (input.pickupStatus ?? current.reviews[listingId]?.pickupStatus ?? "None") as FreeFindsPickupStatus, pickupNotes: String(input.pickupNotes ?? ""), pickupAt, notes: String(input.notes ?? ""), reviewedAt: new Date().toISOString() };
  await mkdir(root, { recursive: true });
  await writeFile(freeFindsReviewPath(root), `${JSON.stringify({ version: 1, reviews: current.reviews }, null, 2)}\n`, "utf8");
  return { reviews: current.reviews, issues: current.issues };
}

export async function saveFreeFindsReviews(root: string, listingIds: unknown, status: unknown): Promise<FreeFindsReviewState> {
  if (!Array.isArray(listingIds) || listingIds.length === 0 || listingIds.length > 200 || listingIds.some((id) => typeof id !== "string" || !id.trim())) throw new Error("Free Finds bulk review requires 1–200 listing IDs.");
  if (!FREE_FINDS_REVIEW_STATUSES.includes(status as FreeFindsReviewStatus) || status === "Unreviewed") throw new Error("Free Finds bulk review requires a reviewed status.");
  const ids = [...new Set(listingIds as string[])];
  const current = await loadFreeFindsReviews(root);
  const reviewedAt = new Date().toISOString();
  for (const listingId of ids) {
    const previous = current.reviews[listingId];
    current.reviews[listingId] = { status: status as FreeFindsReviewStatus, pickupStatus: previous?.pickupStatus ?? "None", pickupNotes: previous?.pickupNotes ?? "", pickupAt: previous?.pickupAt ?? null, notes: previous?.notes ?? "", reviewedAt };
  }
  await mkdir(root, { recursive: true });
  await writeFile(freeFindsReviewPath(root), `${JSON.stringify({ version: 1, reviews: current.reviews }, null, 2)}\n`, "utf8");
  return { reviews: current.reviews, issues: current.issues };
}
