import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runMcpSearches } from "./hardware-watch-mcp.js";
import { loadActiveWatchConfig } from "./hardware-watch-config.js";
import {
  candidateScore,
  classifyDistance,
  qualifiesAsLocalCandidate,
} from "./hardware-watch-filter.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(
  process.env.HARDWARE_WATCH_OUTPUT_DIR ?? resolve(repoRoot, ".local/hardware-watch"),
);
const statePath = resolve(outputRoot, "state.json");
const driveFolderName = "Hardware Watch Alert Inbox";

const activeConfig = await loadActiveWatchConfig(outputRoot);
const center = activeConfig.center;
const radiusKm = activeConfig.radiusKm;
const queries = activeConfig.queries;

const progress = (message: string) => process.stderr.write(`[hardware-watch] ${message}\n`);

type Listing = {
  id: string;
  title: string;
  price: string;
  location: string;
  url: string;
  is_pending: boolean;
  latitude?: number;
  longitude?: number;
  location_latitude?: number;
  location_longitude?: number;
  coordinates?: { latitude?: number; longitude?: number };
};

type State = { seenIds: string[]; lastRunAt: string | null; lastSnapshotIds?: string[] };
type DriveUpload = {
  status: "uploaded" | "not_configured" | "skipped_run_errors" | "failed";
  folder?: string;
  files?: string[];
  error?: string;
};

async function resolveDriveFolder(): Promise<string | null> {
  const configured = process.env.HARDWARE_WATCH_DRIVE_FOLDER_PATH;
  if (configured) {
    try {
      if ((await stat(configured)).isDirectory()) return configured;
    } catch {
      return null;
    }
  }

  const cloudStorageRoot = resolve(homedir(), "Library/CloudStorage");
  try {
    const entries = await readdir(cloudStorageRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("GoogleDrive-")) continue;
      const candidate = resolve(cloudStorageRoot, entry.name, "My Drive", driveFolderName);
      try {
        if ((await stat(candidate)).isDirectory()) return candidate;
      } catch {
        // Try the next mounted account without exposing account details in output.
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function uploadReports(reportPaths: string[], hasErrors: boolean): Promise<DriveUpload> {
  if (hasErrors) return { status: "skipped_run_errors" };
  const folder = await resolveDriveFolder();
  if (!folder) {
    return {
      status: "not_configured",
      error: "No synced Google Drive folder was found; set HARDWARE_WATCH_DRIVE_FOLDER_PATH to an authorized local Drive folder.",
    };
  }
  try {
    const uploaded: string[] = [];
    for (const source of reportPaths) {
      const filename = source.split("/").pop() ?? "report";
      await copyFile(source, resolve(folder, filename));
      uploaded.push(filename);
    }
    return { status: "uploaded", folder: driveFolderName, files: uploaded };
  } catch (error) {
    return { status: "failed", folder: driveFolderName, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseOutput(response: any): { listings?: Listing[]; count?: number } {
  if (response?.structuredContent?.listings) return response.structuredContent;
  const text = response?.content?.find((part: any) => part.type === "text")?.text;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed?.listings ? parsed : {};
  } catch {
    return {};
  }
}

async function loadState(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<State>;
    return {
      seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds.filter((id): id is string => typeof id === "string") : [],
      lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
      lastSnapshotIds: Array.isArray(parsed.lastSnapshotIds) ? parsed.lastSnapshotIds.filter((id): id is string => typeof id === "string") : undefined,
    };
  } catch {
    return { seenIds: [], lastRunAt: null };
  }
}

const isSyntheticPlaceholderId = (id: unknown): boolean => typeof id === "string" && id.includes("IN_MEMORY_MARKETPLACE_FEED_STORY_ENT");

async function loadPreviousSnapshotIds(state: State): Promise<Set<string> | null> {
  if (!state.lastRunAt) return null;
  if (Array.isArray(state.lastSnapshotIds)) return new Set(state.lastSnapshotIds.filter((id) => !isSyntheticPlaceholderId(id)));
  try {
    const names = await readdir(outputRoot);
    for (const name of names.filter((value) => value.startsWith("report-") && value.endsWith(".json"))) {
      const data = JSON.parse(await readFile(resolve(outputRoot, name), "utf8")) as Record<string, unknown>;
      if (data.runAt !== state.lastRunAt) continue;
      const snapshot = Array.isArray(data.rawListings) ? data.rawListings : Array.isArray(data.newListings) ? data.newListings : null;
      if (!snapshot) return null;
      return new Set(snapshot.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string").map((value) => String(value.id)).filter((id) => !isSyntheticPlaceholderId(id)));
    }
  } catch {
    return null;
  }
  return null;
}

function markdownReport(report: any): string {
  const lines = [
    `# Hardware Deal Watch — ${report.runAt}`,
    "",
    `Read-only Facebook Marketplace search around Churchville, Maryland (${center.latitude}, ${center.longitude}), radius ${radiusKm} km.`,
    "Bounded method: per-query limits and page counts from the applied local configuration; no Marketplace monitors, no seller contact, no purchases.",
    "",
    `New qualifying IDs not in prior watcher state: ${report.newListings.length}`,
    `New IDs since previous comparable snapshot: ${report.snapshotComparisonStatus === "available" ? report.newSincePreviousSnapshot.length : "unavailable"}`,
    "Newly posted Marketplace items: unavailable from saved report evidence.",
    `Disappeared since previous snapshot: ${report.disappearedSincePreviousSnapshot.length}`,
    `Reappeared after an absence: ${report.reappearedSincePreviousSnapshot.length}`,
    `Search errors: ${report.errors.length}`,
    "",
    "## New candidates",
    "",
  ];
  if (!report.newListings.length) lines.push("No new qualifying IDs were added to the prior watcher state.", "");
  for (const listing of report.newListings) {
    lines.push(`- **${listing.title}** — ${listing.price} — ${listing.location} — ${listing.url}`);
    lines.push(`  - category: ${listing.kind}; score: ${listing.score}; distance: ${listing.distanceLabel}; pending: ${listing.is_pending}`);
  }
  lines.push("", "## Raw returned listings", "");
  for (const listing of report.rawListings) {
    if (listing.distanceStatus === "in_radius" && listing.isCandidate) continue;
    lines.push(`- **${listing.title}** — ${listing.price} — ${listing.location} — ${listing.url}`);
    lines.push(`  - ${listing.distanceLabel}; candidate excluded: ${listing.exclusionReason}`);
  }
  lines.push("", "## Query summary", "");
  for (const result of report.results) {
    lines.push(`- ${result.kind}: **${result.query}** — ${result.count} returned${result.error ? `; error: ${result.error}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

progress("startup: preparing output and MCP session");
await mkdir(outputRoot, { recursive: true });
const state = await loadState();
const previousIds = new Set(state.seenIds);
const previousSnapshotIds = await loadPreviousSnapshotIds(state);
const snapshotComparisonStatus = !state.lastRunAt ? "first_run" : previousSnapshotIds ? "available" : "unavailable";
const currentIds = new Set<string>();
const results: any[] = [];
const errors: any[] = [];
const allListings = new Map<string, Listing & { kind: string; queries: string[] }>();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(repoRoot, "dist/index.js")],
  cwd: repoRoot,
  stderr: "pipe",
});
const client = new Client({ name: "hardware-deal-watch", version: "1.0.0" });

const searchRun = await runMcpSearches({
  client,
  transport,
  searches: queries,
  progress,
  callArguments: (search) => {
    const args: Record<string, unknown> = {
      query: search.query,
      latitude: center.latitude,
      longitude: center.longitude,
      radius_km: radiusKm,
      limit: search.limit,
      max_pages: search.maxPages,
      response_format: "json",
    };
    if (search.minPrice !== null) args.min_price = search.minPrice;
    if (search.maxPrice !== null) args.max_price = search.maxPrice;
    return { name: "facebook_marketplace_search_listings", arguments: args };
  },
  parseCount: (response) => parseOutput(response).listings?.length ?? 0,
  onResponse: ({ kind, query }, response) => {
    const listings = parseOutput(response).listings ?? [];
    for (const listing of listings) {
      if (!isSyntheticPlaceholderId(listing.id)) currentIds.add(listing.id);
      const existing = allListings.get(listing.id);
      if (existing) existing.queries.push(query);
      else allListings.set(listing.id, { ...listing, kind, queries: [query] });
    }
  },
});
results.push(...searchRun.results);
errors.push(...searchRun.errors);
progress("filtering: processing returned listings");

const runAt = new Date().toISOString();
const rawListings = [...allListings.values()].map((listing) => {
  const diagnosticOnly = isSyntheticPlaceholderId(listing.id);
  const distance = classifyDistance(listing);
  const score = candidateScore(listing, listing.kind);
  const isCandidate = !diagnosticOnly && qualifiesAsLocalCandidate(listing, listing.kind);
  return {
    ...listing,
    score,
    distanceStatus: distance.status,
    distanceKm: distance.distanceKm,
    distanceMethod: distance.method,
    distanceLabel: distance.distanceKm === null ? "distance unverified" : `${distance.distanceKm} km from Churchville`,
    isCandidate,
    diagnosticOnly,
    exclusionReason: diagnosticOnly
      ? "synthetic Marketplace no-results record; diagnostic only"
      : distance.status === "out_of_radius"
      ? "out of radius"
      : distance.status === "unverified"
        ? "distance unverified"
        : score < 0
          ? "does not meet the documented hardware/price criteria"
          : "",
  };
});
const genuineListings = rawListings.filter((listing) => !listing.diagnosticOnly);
const newListings = genuineListings
  .filter((listing) => !previousIds.has(listing.id) && listing.isCandidate)
  .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
const newSincePreviousSnapshot = previousSnapshotIds === null
  ? []
  : genuineListings.filter((listing) => !previousSnapshotIds.has(listing.id));
const disappearedSincePreviousSnapshot = previousSnapshotIds === null
  ? []
  : [...previousSnapshotIds].filter((id) => !currentIds.has(id));
const reappearedSincePreviousSnapshot = previousSnapshotIds === null
  ? []
  : [...currentIds].filter((id) => !previousSnapshotIds.has(id) && previousIds.has(id));

const nextSeenIds = [...new Set([...state.seenIds, ...currentIds])].slice(-5000);
const report = {
  runAt,
  previousRunAt: state.lastRunAt,
  center,
  radiusKm,
  limit: Math.max(...queries.map((query) => query.limit)),
  maxPages: Math.max(...queries.map((query) => query.maxPages)),
  queries,
  configuration: activeConfig,
  readOnly: true,
  monitorsCreated: false,
  detailsFetched: 0,
  results,
  errors,
  newListings,
  newSincePreviousSnapshot: snapshotComparisonStatus === "available" ? newSincePreviousSnapshot : [],
  snapshotComparisonStatus,
  newlyPostedListings: null,
  newlyPostedStatus: "unavailable_without_posting_history",
  disappearedSincePreviousSnapshot,
  reappearedSincePreviousSnapshot,
  rawListings,
  snapshot: { format: "complete", source: "rawListings", listingCount: genuineListings.length, diagnosticOnlyCount: rawListings.length - genuineListings.length },
  deduplicatedListingCount: genuineListings.length,
  driveUpload: { status: "pending" } as DriveUpload | { status: "pending" },
};
const stamp = runAt.replace(/[:.]/g, "-");
const jsonPath = resolve(outputRoot, `report-${stamp}.json`);
const markdownPath = resolve(outputRoot, `report-${stamp}.md`);
progress(`report write: starting (${jsonPath})`);
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(markdownPath, markdownReport(report), "utf8");
progress("report write: local files complete");
progress("Drive upload: starting");
report.driveUpload = await uploadReports([jsonPath, markdownPath], errors.length > 0);
progress(`Drive upload: ${report.driveUpload.status}`);
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(markdownPath, markdownReport(report), "utf8");
if (report.driveUpload.status === "uploaded") {
  await uploadReports([jsonPath, markdownPath], false);
  progress("Drive upload: final report copies refreshed");
}
await writeFile(statePath, `${JSON.stringify({ seenIds: nextSeenIds, lastRunAt: runAt, lastSnapshotIds: [...currentIds] }, null, 2)}\n`, "utf8");
progress("report write: state complete");
console.log(JSON.stringify({ runAt, outputRoot, newListings: newListings.length, errors: errors.length, deduplicatedListingCount: allListings.size, driveUpload: report.driveUpload }, null, 2));
