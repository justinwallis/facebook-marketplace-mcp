import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { classifyDistance, type WatchListing } from "./hardware-watch-filter.js";
import { loadReviewState, REVIEW_STATUSES, type ListingReview, type ReviewStatus } from "./hardware-watch-review.js";

export type DashboardStatus = "missing" | "malformed" | "stale" | "error" | "empty" | "ready";

export type DashboardListing = {
  id: string;
  title: string;
  imageUrl: string | null;
  price: string;
  location: string;
  url: string;
  kind: "mac" | "proxmox" | "unknown";
  category: "Mac Studio" | "Proxmox" | "Unknown";
  distanceStatus: "in_radius" | "out_of_radius" | "unverified";
  distanceKm: number | null;
  distanceLabel: string;
  score: number | null;
  matchSummary: string;
  targetFit: string;
  priceValue: number | null;
  priceAssessment: string;
  locationConfidence: string;
  missingSpecs: string[];
  rankScore: number | null;
  runAt: string | null;
  isCandidate: boolean;
  proxmoxGroup: "complete_computer" | "component" | "incomplete_system" | null;
  proxmoxBuildFit: string | null;
  nextChecks: string[];
  additionalParts: string[];
  totalBuildCost: string;
  reviewStatus: ReviewStatus;
  reviewNotes: string;
  manualDetails: string;
  reviewedAt: string | null;
};

export type DashboardChangeListing = DashboardListing & {
  changeType: "new" | "updated";
  changeSummary: string;
  fieldChanges: FieldChange[];
  changePriority: number;
};

export type FieldChange = {
  field: "price" | "title" | "location" | "pending/availability" | "seller" | "posted date" | "URL";
  previous: string;
  current: string;
  kind: "price_decrease" | "price_increase" | "availability" | "changed";
};

export type NewSinceLastRun = {
  status: "first_run" | "missing_history" | "no_change" | "available" | "stale" | "error";
  runAt: string | null;
  previousRunAt: string | null;
  message: string;
  newListings: DashboardChangeListing[];
  updatedListings: DashboardChangeListing[];
};

export type RunQuerySummary = {
  kind: string;
  query: string;
  count: number | null;
  error: string | null;
};

export type RunHistoryEntry = {
  name: string;
  runAt: string | null;
  status: "ready" | "partial" | "stale" | "empty" | "malformed";
  candidateCount: number | null;
  diagnosticCount: number | null;
  newCount: number | null;
  updatedCount: number | null;
  errors: string[];
  querySummaries: RunQuerySummary[];
  comparisonSource: string | null;
  warnings: string[];
};

export type TriageFilter = "all" | "new" | "price_drop" | "newly_available" | ReviewStatus;

export function buildManualReviewChecklist(listing: Pick<DashboardListing, "title" | "price" | "location" | "distanceLabel" | "nextChecks">): string {
  const checks = listing.nextChecks.length ? listing.nextChecks.map((check) => `- [ ] ${check}`) : ["- [ ] No additional checks recorded in the report."];
  return [
    "Hardware Watch manual review checklist",
    `Listing: ${listing.title}`,
    `Reported price: ${listing.price}`,
    `Reported location: ${listing.location} — ${listing.distanceLabel}`,
    "Evidence-based checks:",
    ...checks,
  ].join("\n");
}

export function matchesTriageFilter(
  listing: Pick<DashboardListing, "id" | "reviewStatus">,
  filter: TriageFilter,
  changes: DashboardChangeListing[],
): boolean {
  if (filter === "all") return true;
  if (REVIEW_STATUSES.includes(filter as ReviewStatus)) return listing.reviewStatus === filter;
  const change = changes.find((item) => item.id === listing.id);
  if (!change) return false;
  if (filter === "new") return change.changeType === "new";
  if (filter === "price_drop") return change.fieldChanges.some((field) => field.kind === "price_decrease");
  return change.fieldChanges.some((field) => field.kind === "availability" && field.current === "Available");
}

export type DashboardData = {
  reportRoot: string;
  status: DashboardStatus;
  statusMessage: string;
  latestRunAt: string | null;
  latestReportName: string | null;
  latestReportErrors: string[];
  stale: boolean;
  candidates: DashboardListing[];
  diagnostics: DashboardListing[];
  issues: string[];
  reportCount: number;
  bestSectionTitle: string;
  bestSectionNote: string;
  reviews: Record<string, ListingReview>;
  reviewIssues: string[];
  staleReviewIds: string[];
  newSinceLastRun: NewSinceLastRun;
  runHistory: RunHistoryEntry[];
};

const STALE_AFTER_MS = 36 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "Unknown"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function parsePrice(value: unknown): { value: number | null; assessment: string } {
  const price = typeof value === "string" ? value.trim() : "";
  if (!price || /n\/a|unknown|contact|call for|obo|trade/i.test(price)) return { value: null, assessment: "Price unknown or negotiable." };
  if (/^\$?\s*0(?:\.0+)?\s*$/i.test(price) && !/\bfree\b/i.test(price)) return { value: null, assessment: "$0 may be a placeholder; price needs verification." };
  if (/\bfree\b/i.test(price)) return { value: 0, assessment: "Explicitly listed as free." };
  const match = price.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!match) return { value: null, assessment: "Price is not parseable." };
  return { value: Number(match[1]), assessment: `Asking price ${price}.` };
}

function comparePrice(kind: DashboardListing["kind"], value: number | null, assessment: string): string {
  if (value === null) return assessment;
  if (kind === "mac") {
    return `${assessment} Within the documented $1,500–$1,900 Mac Studio target band.`;
  }
  if (kind === "proxmox") {
    if (value <= 1_000) return `${assessment} Asking price is below the documented $1,000 all-in Proxmox build budget; total build cost is unknown because required parts and upgrades are not priced.`;
    return `${assessment} Asking price exceeds the documented $1,000 all-in Proxmox build budget; total build cost is unknown.`;
  }
  return assessment;
}

function targetEvaluation(value: Record<string, unknown>, kind: "mac" | "proxmox" | "unknown", price: number | null): {
  supported: boolean;
  targetFit: string;
  missingSpecs: string[];
  score: number;
  proxmoxGroup: DashboardListing["proxmoxGroup"];
  proxmoxBuildFit: string | null;
} {
  const text = stringValue(value.title, "").toLowerCase();
  const missingSpecs: string[] = [];
  if (kind === "mac") {
    if (/\bmacbook\b/.test(text)) return { supported: false, targetFit: "MacBook, not a Mac Studio", missingSpecs: ["Mac Studio model"], score: 0, proxmoxGroup: null, proxmoxBuildFit: null };
    if (!/\bmac\s+studio\b/.test(text)) return { supported: false, targetFit: "Not identified as a Mac Studio", missingSpecs: ["Mac Studio model"], score: 0, proxmoxGroup: null, proxmoxBuildFit: null };
    const isM2Max = /\bm2\s+max\b/.test(text);
    const isM2Ultra = /\bm2\s+ultra\b/.test(text);
    const has96Gb = /\b96\s*gb\b/.test(text);
    const has128Gb = /\b128\s*gb\b/.test(text);
    if (isM2Max && has96Gb) {
      if (!/\b1\s*tb\b/.test(text)) missingSpecs.push("1 TB SSD preference not stated");
      return { supported: true, targetFit: "M2 Max + 96 GB unified memory target", missingSpecs, score: 70 + (missingSpecs.length ? 0 : 8), proxmoxGroup: null, proxmoxBuildFit: null };
    }
    if (isM2Ultra && has128Gb && price !== null && price <= 1_900) {
      if (!/\b(?:1|2|4|8)\s*tb\b/.test(text)) missingSpecs.push("SSD capacity not stated");
      return { supported: true, targetFit: "M2 Ultra + 128 GB exceptional comparison", missingSpecs, score: 62 + (missingSpecs.length ? 0 : 8), proxmoxGroup: null, proxmoxBuildFit: null };
    }
    if (!isM2Max && !isM2Ultra) missingSpecs.push("M2 Max or M2 Ultra model");
    if (isM2Max && !has96Gb) missingSpecs.push("96 GB unified memory");
    if (isM2Ultra && !has128Gb) missingSpecs.push("128 GB unified memory");
    return { supported: false, targetFit: "Mac Studio, but not a documented target configuration", missingSpecs, score: 0, proxmoxGroup: null, proxmoxBuildFit: null };
  }
  if (kind !== "proxmox") return { supported: false, targetFit: "Unsupported target category", missingSpecs: ["Supported hardware category"], score: 0, proxmoxGroup: null, proxmoxBuildFit: null };
  const laptopPlatform = /laptop|notebook|\bxps\b/.test(text);
  if (/bag|cover|cable|stand|case|panel|service|parts only/.test(text)) return { supported: false, targetFit: "Accessory, not a reusable Proxmox component/system", missingSpecs: ["Reusable x86 component/system"], score: 0, proxmoxGroup: "incomplete_system", proxmoxBuildFit: "Not a build candidate: accessory or service." };
  const modernCpu = text.match(/(?:i[3579][ -]?\d{4,5}|ryzen\s*[3579]\s*\d{4,5}|threadripper|xeon)/i)?.[0];
  const compatibleMemory = /\bddr[45]\b|\b\d+\s*gb\s*(?:ram|memory)\b/i.test(text);
  const ramCapacity = text.match(/\b(\d+)\s*gb\s*(?:ddr[45]\s*)?(?:ram|memory)\b|\bddr[45]\s*(\d+)\s*gb\b/i);
  const storage = /\b(?:nvme|ssd)\b/i.test(text);
  const board = /motherboard|mobo|cpu\s*(?:\+|and)\s*(?:ram|memory)/i.test(text);
  const statedGpu = /\b(?:rtx|quadro|radeon|gpu|graphics)\b/i.test(text);
  const component = board || /\b(?:ddr[45]|ram|memory|nvme|ssd)\b/i.test(text) && !/\b(?:desktop|workstation|tower|server|system|pc)\b/i.test(text);
  const completeSystem = Boolean(modernCpu && compatibleMemory && storage && !laptopPlatform && /\b(?:desktop|workstation|tower|server|system|pc|optiplex|thinkstation|z2)\b/i.test(text));
  const buildFit = (group: "complete_computer" | "component" | "incomplete_system"): string => {
    if (group === "component") return "Build fit: component only; not a complete Proxmox build. Compatibility with the final platform remains unverified.";
    const met = [
      modernCpu ? `CPU/platform stated (${modernCpu})` : "CPU/platform missing",
      compatibleMemory ? `RAM stated${ramCapacity ? ` (${ramCapacity[1] ?? ramCapacity[2]} GB)` : ""}` : "RAM missing",
      storage ? "storage stated" : "storage missing",
      statedGpu ? "GPU stated" : "GPU not stated",
    ];
    const missing = [
      !modernCpu ? "CPU/platform" : "",
      !compatibleMemory ? "RAM capacity/type" : "",
      !storage ? "storage" : "",
      !statedGpu ? "target GPU" : "",
      ramCapacity && Number(ramCapacity[1] ?? ramCapacity[2]) < 128 ? "128 GB RAM target" : "128 GB RAM target not confirmed",
      "working condition and final component compatibility",
    ].filter(Boolean);
    return `${group === "complete_computer" ? "Complete computer candidate" : "Incomplete system"}; met: ${met.join(", ")}; missing/unverified: ${missing.join(", ")}.`;
  };
  if (!modernCpu && !compatibleMemory && !storage && !board) return { supported: false, targetFit: "Insufficient hardware evidence", missingSpecs: ["Modern x86/compatible component evidence"], score: 0, proxmoxGroup: "incomplete_system", proxmoxBuildFit: buildFit("incomplete_system") };
  if (!modernCpu) missingSpecs.push("CPU/platform not stated");
  if (!compatibleMemory) missingSpecs.push("RAM type/capacity not stated");
  if (!storage && !board) missingSpecs.push("SSD or motherboard compatibility not stated");
  if (laptopPlatform) {
    return { supported: false, targetFit: "Laptop platform; not validated as a reusable desktop Proxmox system", missingSpecs: ["Desktop/server form factor compatibility"], score: 0, proxmoxGroup: "incomplete_system", proxmoxBuildFit: "Incomplete system; laptop form factor is not validated for the planned Proxmox build." };
  }
  if (completeSystem) {
    return {
      supported: true,
      targetFit: `Complete computer evidence: ${modernCpu}; RAM; storage${/\b(?:rtx|quadro|radeon|gpu|graphics)\b/i.test(text) ? "; stated GPU" : ""}`,
      missingSpecs,
      score: 65 + (board ? 10 : 0),
      proxmoxGroup: "complete_computer",
      proxmoxBuildFit: buildFit("complete_computer"),
    };
  }
  if (component) {
    return { supported: true, targetFit: "Reusable Proxmox component evidence", missingSpecs, score: 35 + (board ? 10 : 0), proxmoxGroup: "component", proxmoxBuildFit: buildFit("component") };
  }
  return {
    supported: true,
    targetFit: modernCpu ? `Incomplete system evidence: ${modernCpu}` : "Incomplete Proxmox system evidence",
    missingSpecs,
    score: 45 + (modernCpu ? 18 : 0) + (board ? 10 : 0) + (compatibleMemory ? 8 : 0) + (storage ? 5 : 0),
    proxmoxGroup: "incomplete_system",
    proxmoxBuildFit: buildFit("incomplete_system"),
  };
}

function category(kind: unknown): DashboardListing["category"] {
  return kind === "mac" ? "Mac Studio" : kind === "proxmox" ? "Proxmox" : "Unknown";
}

function nextChecksFor(kind: DashboardListing["kind"], evaluation: ReturnType<typeof targetEvaluation>): string[] {
  if (kind === "mac") {
    const checks = ["Confirm working condition and exact configuration from the listing details"];
    if (evaluation.missingSpecs.some((spec) => /ssd/i.test(spec))) checks.push("Confirm SSD capacity");
    if (evaluation.missingSpecs.some((spec) => /memory/i.test(spec))) checks.push("Confirm unified-memory capacity");
    return checks;
  }
  if (kind !== "proxmox") return ["Confirm the hardware category and specifications"];
  if (evaluation.proxmoxGroup === "component") return [
    "Confirm the component is tested and in working condition",
    "Verify compatibility with the selected CPU, motherboard, RAM type, and storage platform",
  ];
  if (evaluation.proxmoxGroup === "complete_computer") return [
    "Confirm working condition",
    "Verify CPU, motherboard, RAM, storage, and stated GPU compatibility for the planned Proxmox build",
    "Confirm whether the 128 GB RAM target can be met",
  ];
  const checks = evaluation.missingSpecs.map((spec) => `Confirm ${spec.toLowerCase()}`);
  checks.push("Confirm working condition and compatibility for the planned Proxmox build");
  return checks;
}

function additionalPartsFor(value: Record<string, unknown>, kind: DashboardListing["kind"], evaluation: ReturnType<typeof targetEvaluation>): string[] {
  if (kind !== "proxmox") return ["No additional parts or upgrade costs are provided in the report"];
  const text = stringValue(value.title, "").toLowerCase();
  const ram = text.match(/\b(\d+)\s*gb\s*(?:ddr[45]\s*)?(?:ram|memory)\b|\bddr[45]\s*(\d+)\s*gb\b/i);
  if (evaluation.proxmoxGroup === "complete_computer") {
    const capacity = ram ? Number(ram[1] ?? ram[2]) : null;
    return [
      capacity !== null && capacity < 128 ? `At least ${128 - capacity} GB more RAM capacity to reach the 128 GB target; module compatibility is unverified` : "Confirm RAM capacity and compatibility with the 128 GB target",
      "Working-condition and platform-compatibility checks are still needed",
      "Any omitted build components and their prices are unknown",
    ];
  }
  if (evaluation.proxmoxGroup === "component") return [
    "Remaining CPU/platform, motherboard, RAM, storage, and/or GPU parts depend on this component",
    "Compatibility and prices for the rest of the build are unknown",
  ];
  return [
    ...evaluation.missingSpecs.map((spec) => `Additional evidence or hardware for ${spec.toLowerCase()}`),
    "Additional parts and their prices are unknown",
  ];
}

function normalizeListing(value: unknown, runAt: string | null): DashboardListing | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return null;
  const kind = value.kind === "mac" || value.kind === "proxmox" ? value.kind : "unknown";
  const distance = classifyDistance({ ...value, location: stringValue(value.location) } as WatchListing);
  const status = distance.status;
  const distanceKm = distance.distanceKm;
  const score = numberValue(value.score);
  const parsedPrice = parsePrice(value.price);
  const priceAssessment = comparePrice(kind, parsedPrice.value, parsedPrice.assessment);
  const evaluation = targetEvaluation(value, kind, parsedPrice.value);
  const nextChecks = nextChecksFor(kind, evaluation);
  const additionalParts = additionalPartsFor(value, kind, evaluation);
  const totalBuildCost = kind === "proxmox"
    ? "Unknown — the report provides only this listing's asking price, not all required parts and upgrades."
    : "Unknown — the report does not provide a total acquisition or upgrade cost.";
  const locationConfidence = status === "in_radius"
    ? `Verified in radius${distanceKm === null ? " from returned location data" : ` (${distanceKm} km from Churchville)`}.`
    : status === "out_of_radius" ? "Returned location is outside the 80 km radius." : "Location distance is unverified.";
  const priceEligible = parsedPrice.value !== null && (kind === "mac" ? parsedPrice.value >= 1_500 && parsedPrice.value <= 1_900 : kind === "proxmox" && parsedPrice.value <= 1_000);
  const qualifies = status === "in_radius" && evaluation.supported && priceEligible && (kind !== "proxmox" || evaluation.proxmoxGroup !== "incomplete_system");
  const rankScore = qualifies ? evaluation.score + (kind === "mac" ? Math.max(0, 10 - Math.abs((parsedPrice.value ?? 1_600) - 1_600) / 30) : Math.max(0, 10 - (parsedPrice.value ?? 1_000) / 100)) : null;
  const exclusions = [
    !evaluation.supported ? evaluation.targetFit : "",
    !priceEligible ? priceAssessment : "",
    status !== "in_radius" ? locationConfidence : "",
  ].filter(Boolean);
  const reason = qualifies
    ? `${evaluation.targetFit}; ${priceAssessment} ${locationConfidence}${evaluation.missingSpecs.length ? ` Missing/optional: ${evaluation.missingSpecs.join(", ")}.` : ""}`
    : `Possible lead — needs verification: ${exclusions.join(" ") || "not eligible for the verified deal view."}`;
  return {
    id: value.id,
    title: value.title,
    imageUrl: normalizeImageUrl(value.image_url),
    price: stringValue(value.price),
    location: stringValue(value.location),
    url: stringValue(value.url, "#"),
    kind,
    category: category(kind),
    distanceStatus: status,
    distanceKm,
    distanceLabel: distanceKm === null ? "distance unverified" : `${distanceKm} km from Churchville`,
    score,
    matchSummary: reason,
    targetFit: evaluation.targetFit,
    priceValue: parsedPrice.value,
    priceAssessment,
    locationConfidence,
    missingSpecs: evaluation.missingSpecs,
    rankScore,
    runAt,
    isCandidate: qualifies,
    proxmoxGroup: evaluation.proxmoxGroup,
    proxmoxBuildFit: evaluation.proxmoxBuildFit,
    nextChecks,
    additionalParts,
    totalBuildCost,
    reviewStatus: "Unreviewed",
    reviewNotes: "",
    manualDetails: "",
    reviewedAt: null,
  };
}

function reportTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function reportErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (isRecord(entry)) return stringValue(entry.error, "Search error");
    return typeof entry === "string" ? entry : "Search error";
  });
}

function sortNewest(a: DashboardListing, b: DashboardListing): number {
  return (Date.parse(b.runAt ?? "") || 0) - (Date.parse(a.runAt ?? "") || 0);
}

function reportListings(report: { data: Record<string, unknown> }): Record<string, unknown>[] | null {
  const raw = Array.isArray(report.data.rawListings)
    ? report.data.rawListings
    : Array.isArray(report.data.newListings)
      ? report.data.newListings
      : null;
  if (!raw) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of raw) if (isRecord(value) && typeof value.id === "string" && !byId.has(value.id)) byId.set(value.id, value);
  return [...byId.values()];
}

function listingChangeFields(value: Record<string, unknown>): Array<[FieldChange["field"], unknown]> {
  return [
    ["title", value.title],
    ["price", value.price],
    ["location", value.location],
    ["URL", value.url],
    ["posted date", value.posted_date],
    ["pending/availability", value.is_pending],
    ["seller", value.seller_name],
  ];
}

function changeValue(value: unknown, field: FieldChange["field"]): string {
  if (value === undefined || value === null || value === "") return "(unavailable)";
  if (field === "pending/availability") return value === true ? "Pending" : value === false ? "Available" : String(value);
  return String(value);
}

function fieldChanges(previous: Record<string, unknown>, current: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];
  const currentFields = new Map(listingChangeFields(current));
  for (const [field, before] of listingChangeFields(previous)) {
    const after = currentFields.get(field);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const beforePrice = field === "price" ? parsePrice(before).value : null;
    const afterPrice = field === "price" ? parsePrice(after).value : null;
    const kind = field === "price" && beforePrice !== null && afterPrice !== null && afterPrice < beforePrice
      ? "price_decrease"
      : field === "price" && beforePrice !== null && afterPrice !== null && afterPrice > beforePrice
        ? "price_increase"
        : field === "pending/availability" ? "availability" : "changed";
    changes.push({ field, previous: changeValue(before, field), current: changeValue(after, field), kind });
  }
  return changes;
}

function changePriority(changeType: DashboardChangeListing["changeType"], changes: FieldChange[]): number {
  if (changeType === "new") return 2;
  if (changes.some((change) => change.kind === "price_decrease")) return 0;
  if (changes.some((change) => change.field === "pending/availability" && change.current === "Available")) return 1;
  if (changes.some((change) => change.kind === "price_increase")) return 3;
  return 4;
}

type SavedReport = { name: string; data: Record<string, unknown>; modifiedAt: number };

function querySummaries(data: Record<string, unknown>): RunQuerySummary[] {
  const queries = Array.isArray(data.queries) ? data.queries : [];
  const results = Array.isArray(data.results) ? data.results : [];
  return queries.filter(isRecord).map((query, index) => {
    const result = isRecord(results[index]) ? results[index] : null;
    const resultError = result && typeof result.error === "string" ? result.error : null;
    return {
      kind: stringValue(query.kind, "unknown"),
      query: stringValue(query.query, "Unnamed query"),
      count: result && typeof result.count === "number" && Number.isFinite(result.count) ? result.count : null,
      error: resultError,
    };
  });
}

function historyStatus(data: Record<string, unknown>, runAt: string | null, now: Date, candidateCount: number | null, diagnosticCount: number | null): RunHistoryEntry["status"] {
  if (!runAt || now.getTime() - Date.parse(runAt) > STALE_AFTER_MS) return "stale";
  const errors = reportErrors(data.errors);
  if (errors.length) return "partial";
  if (candidateCount === 0 && diagnosticCount === 0) return "empty";
  return "ready";
}

function buildHistoryEntry(report: SavedReport, reports: SavedReport[], now: Date): RunHistoryEntry {
  const runAt = reportTimestamp(report.data.runAt);
  const errors = reportErrors(report.data.errors);
  const raw = reportListings(report);
  let candidateCount: number | null = null;
  let diagnosticCount: number | null = null;
  if (raw) {
    const listings = raw.map((value) => normalizeListing(value, runAt)).filter((value): value is DashboardListing => value !== null);
    candidateCount = listings.filter((listing) => listing.isCandidate).length;
    diagnosticCount = listings.length - candidateCount;
  }
  const newCount = Array.isArray(report.data.newListings) ? report.data.newListings.length : null;
  const updatedCount = Array.isArray(report.data.updatedListings) ? report.data.updatedListings.length : null;
  const previousRunAt = reportTimestamp(report.data.previousRunAt);
  const comparison = previousRunAt ? reports.find((candidate) => candidate !== report && reportTimestamp(candidate.data.runAt) === previousRunAt) : null;
  const warnings: string[] = [];
  if (!runAt) warnings.push("Run timestamp is missing or invalid.");
  if (!raw) warnings.push("Listing snapshot is unavailable; candidate and diagnostic counts are unavailable.");
  if (previousRunAt && !comparison) warnings.push(`The recorded comparison report ${previousRunAt} is missing.`);
  if (runAt && !Array.isArray(report.data.results)) warnings.push("Per-query result counts are unavailable.");
  if (errors.length && querySummaries(report.data).every((summary) => !summary.error)) warnings.push("The report has run-level errors without per-query attribution.");
  return {
    name: report.name,
    runAt,
    status: historyStatus(report.data, runAt, now, candidateCount, diagnosticCount),
    candidateCount,
    diagnosticCount,
    newCount,
    updatedCount,
    errors,
    querySummaries: querySummaries(report.data),
    comparisonSource: comparison?.name ?? null,
    warnings,
  };
}

export async function loadRunHistory(reportRoot: string, now = new Date()): Promise<RunHistoryEntry[]> {
  let filenames: string[];
  try {
    filenames = (await readdir(reportRoot)).filter((name) => name.startsWith("report-") && name.endsWith(".json"));
  } catch {
    return [];
  }
  const reports: SavedReport[] = [];
  for (const name of filenames) {
    try {
      const raw = JSON.parse(await readFile(join(reportRoot, name), "utf8")) as unknown;
      if (!isRecord(raw)) continue;
      const fileStat = await stat(join(reportRoot, name));
      reports.push({ name, data: raw, modifiedAt: fileStat.mtimeMs });
    } catch {
      // Malformed files are surfaced by loadDashboardData's issues list; they cannot be summarized safely.
    }
  }
  reports.sort((a, b) => (Date.parse(stringValue(b.data.runAt, "")) || 0) - (Date.parse(stringValue(a.data.runAt, "")) || 0) || b.modifiedAt - a.modifiedAt);
  return reports.map((report) => buildHistoryEntry(report, reports, now));
}

export async function loadHistoricalRun(reportRoot: string, runAt: string, now = new Date()): Promise<RunHistoryEntry | null> {
  const history = await loadRunHistory(reportRoot, now);
  return history.find((entry) => entry.runAt === runAt) ?? null;
}

function emptyChangeState(status: NewSinceLastRun["status"], message: string, runAt: string | null = null, previousRunAt: string | null = null): NewSinceLastRun {
  return { status, message, runAt, previousRunAt, newListings: [], updatedListings: [] };
}

export async function loadDashboardData(reportRoot: string, now = new Date()): Promise<DashboardData> {
  const issues: string[] = [];
  let filenames: string[] = [];
  try {
    filenames = (await readdir(reportRoot)).filter((name) => name.startsWith("report-") && name.endsWith(".json"));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      reportRoot,
      status: missing ? "missing" : "malformed",
      statusMessage: missing ? "No watcher reports found yet." : "The watcher report directory could not be read.",
      latestRunAt: null,
      latestReportName: null,
      latestReportErrors: [],
      stale: false,
      candidates: [],
      diagnostics: [],
      issues: [missing ? "Report directory is missing." : String(error)],
      reportCount: 0,
      bestSectionTitle: "Best matches",
      bestSectionNote: "No report data is available for comparison.",
      reviews: {},
      reviewIssues: [],
      staleReviewIds: [],
      newSinceLastRun: emptyChangeState("missing_history", "No saved report history is available.") ,
      runHistory: [],
    };
  }

  const reports: Array<{ name: string; data: Record<string, unknown>; modifiedAt: number }> = [];
  const malformedHistory: RunHistoryEntry[] = [];
  for (const name of filenames) {
    try {
      const raw = JSON.parse(await readFile(join(reportRoot, name), "utf8")) as unknown;
      if (!isRecord(raw)) throw new Error("report is not a JSON object");
      const fileStat = await stat(join(reportRoot, name));
      reports.push({ name, data: raw, modifiedAt: fileStat.mtimeMs });
    } catch (error) {
      const message = `${name}: malformed or unreadable (${error instanceof Error ? error.message : String(error)})`;
      issues.push(message);
      malformedHistory.push({ name, runAt: null, status: "malformed", candidateCount: null, diagnosticCount: null, newCount: null, updatedCount: null, errors: [], querySummaries: [], comparisonSource: null, warnings: [message] });
    }
  }

  if (!reports.length) {
    return {
      reportRoot,
      status: filenames.length ? "malformed" : "missing",
      statusMessage: filenames.length ? "No readable watcher reports are available." : "No watcher reports found yet.",
      latestRunAt: null,
      latestReportName: null,
      latestReportErrors: [],
      stale: false,
      candidates: [],
      diagnostics: [],
      issues,
      reportCount: 0,
      bestSectionTitle: "Best matches",
      bestSectionNote: "No readable report data is available for comparison.",
      reviews: {},
      reviewIssues: [],
      staleReviewIds: [],
      newSinceLastRun: emptyChangeState("missing_history", "No saved report history is available."),
      runHistory: malformedHistory,
    };
  }

  reports.sort((a, b) => {
    const aRun = Date.parse(stringValue(a.data.runAt, "")) || 0;
    const bRun = Date.parse(stringValue(b.data.runAt, "")) || 0;
    return bRun - aRun || b.modifiedAt - a.modifiedAt;
  });
  const latest = reports[0];
  const runHistory = [...reports.map((report) => buildHistoryEntry(report, reports, now)), ...malformedHistory];
  const latestRunAt = reportTimestamp(latest.data.runAt);
  const latestErrors = reportErrors(latest.data.errors);
  const stale = !latestRunAt || now.getTime() - Date.parse(latestRunAt) > STALE_AFTER_MS;
  const latestPreviousRunAt = reportTimestamp(latest.data.previousRunAt);
  const previousReport = latestPreviousRunAt
    ? reports.find((report) => report !== latest && reportTimestamp(report.data.runAt) === latestPreviousRunAt) ?? null
    : null;
  const latestRaw = reportListings(latest);
  const previousRaw = previousReport ? reportListings(previousReport) : null;
  let newSinceLastRun = emptyChangeState(
    stale ? "stale" : latestErrors.length ? "error" : latestPreviousRunAt ? "missing_history" : "first_run",
    stale
      ? "The latest report is stale; change results are shown only as historical diagnostics."
      : latestErrors.length
        ? "The latest report recorded search errors; change results are not treated as complete history."
      : latestPreviousRunAt
        ? "The referenced previous report is not available or does not contain a complete listing snapshot."
        : "This is the first saved report; no earlier snapshot is available for comparison.",
    latestRunAt,
    latestPreviousRunAt,
  );
  if (latestRaw && previousRaw && latestPreviousRunAt && previousReport) {
    const previousById = new Map(previousRaw.map((listing) => [listing.id as string, listing]));
    const newChanges: DashboardChangeListing[] = [];
    const updatedChanges: DashboardChangeListing[] = [];
    for (const value of latestRaw) {
      const listing = normalizeListing(value, latestRunAt);
      if (!listing) continue;
      const prior = previousById.get(value.id as string);
      const changes = prior ? fieldChanges(prior, value) : [];
      if (!prior) newChanges.push({ ...listing, changeType: "new", changeSummary: "Not present in the previous saved report.", fieldChanges: [], changePriority: changePriority("new", []) });
      else if (changes.length) updatedChanges.push({ ...listing, changeType: "updated", changeSummary: `Changed since the previous saved report: ${changes.map((change) => change.field).join(", ")}.`, fieldChanges: changes, changePriority: changePriority("updated", changes) });
    }
    newSinceLastRun = {
      status: stale ? "stale" : latestErrors.length ? "error" : newChanges.length || updatedChanges.length ? "available" : "no_change",
      message: stale
        ? "The latest report is stale; these are historical changes and are not a freshness signal."
        : latestErrors.length
          ? "The latest report recorded search errors; changes are shown only as partial historical diagnostics."
        : newChanges.length || updatedChanges.length
          ? "Compared listing IDs and bounded listing fields with the referenced previous saved report."
          : "No listing-field changes were found compared with the referenced previous saved report.",
      runAt: latestRunAt,
      previousRunAt: latestPreviousRunAt,
      newListings: newChanges,
      updatedListings: updatedChanges,
    };
  }
  const allCandidates: DashboardListing[] = [];
  const latestDiagnostics: DashboardListing[] = [];

  for (const report of reports) {
    const runAt = reportTimestamp(report.data.runAt);
    const candidates = Array.isArray(report.data.newListings) ? report.data.newListings : [];
    for (const value of candidates) {
      const listing = normalizeListing(value, runAt);
      if (listing) {
        if (report === latest && (stale || latestErrors.length > 0)) {
          listing.matchSummary = `Possible lead — needs verification: latest report is ${stale ? "stale" : "partial due to search errors"}. ${listing.matchSummary}`;
          latestDiagnostics.push(listing);
        } else if (!stale && latestErrors.length === 0 && listing.isCandidate) allCandidates.push(listing);
        else if (report === latest) latestDiagnostics.push(listing);
      }
    }
    if (report === latest) {
      const raw = Array.isArray(report.data.rawListings) ? report.data.rawListings : candidates;
      for (const value of raw) {
        const listing = normalizeListing(value, runAt);
        if (!listing) continue;
        if (!stale && latestErrors.length === 0 && listing.isCandidate) {
          allCandidates.push(listing);
        } else if (!latestDiagnostics.some((existing) => existing.id === listing.id)) {
          latestDiagnostics.push(listing);
        }
      }
    }
  }

  const deduplicated = new Map<string, DashboardListing>();
  for (const listing of allCandidates.sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0) || sortNewest(a, b))) {
    if (!deduplicated.has(listing.id)) deduplicated.set(listing.id, listing);
  }
  const status: DashboardStatus = stale
    ? "stale"
    : latestErrors.length
      ? "error"
      : deduplicated.size
        ? "ready"
        : "empty";
  const statusMessage = status === "stale"
    ? "The latest watcher report is stale."
    : status === "error"
      ? "The latest watcher run recorded search errors."
      : status === "empty"
        ? "The latest run completed with no verified deal candidates."
        : "Latest report loaded; verified candidates are shown below.";

  const reviewState = await loadReviewState(reportRoot);
  const allListingIds = new Set([...deduplicated.keys(), ...latestDiagnostics.map((listing) => listing.id)]);
  const staleReviewIds = Object.keys(reviewState.reviews).filter((id) => !allListingIds.has(id));
  const attachReview = (listing: DashboardListing): DashboardListing => {
    const review = reviewState.reviews[listing.id];
    return review ? { ...listing, reviewStatus: review.status, reviewNotes: review.notes, manualDetails: review.manualDetails, reviewedAt: review.reviewedAt } : listing;
  };
  const candidatesWithReviews = [...deduplicated.values()].map(attachReview);
  const diagnosticsWithReviews = latestDiagnostics.sort(sortNewest).map(attachReview);
  const attachChangeReview = (listing: DashboardChangeListing): DashboardChangeListing => ({ ...listing, ...(attachReview(listing) as DashboardListing) });

  return {
    reportRoot,
    status,
    statusMessage,
    latestRunAt,
    latestReportName: latest.name,
    latestReportErrors: latestErrors,
    stale,
    candidates: candidatesWithReviews,
    diagnostics: diagnosticsWithReviews,
    issues: [...issues, ...reviewState.issues, ...(staleReviewIds.length ? [`Saved review metadata exists for ${staleReviewIds.length} listing(s) not present in the latest reports.`] : [])],
    reportCount: reports.length,
    bestSectionTitle: "Best matches",
    bestSectionNote: "The local reports contain title, price, and location evidence but not enough condition/comparison data to call these listings definitive deals.",
    reviews: reviewState.reviews,
    reviewIssues: reviewState.issues,
    staleReviewIds,
    newSinceLastRun: {
      ...newSinceLastRun,
      newListings: newSinceLastRun.newListings.map(attachChangeReview),
      updatedListings: newSinceLastRun.updatedListings.map(attachChangeReview),
    },
    runHistory,
  };
}
