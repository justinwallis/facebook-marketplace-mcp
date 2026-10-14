export const WATCH_CENTER = { latitude: 39.56, longitude: -76.25 } as const;
export const WATCH_RADIUS_KM = 80;

export type WatchListing = {
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

export type DistanceStatus = "in_radius" | "out_of_radius" | "unverified";

export type DistanceResult = {
  status: DistanceStatus;
  distanceKm: number | null;
  method: "coordinates" | "known_location" | "unverified";
};

// Marketplace currently exposes city text, not listing coordinates. Keep this
// deliberately small and conservative: an unknown city/state is unverified.
const knownLocations: Record<string, { latitude: number; longitude: number }> = {
  "annapolis, md": { latitude: 38.9784, longitude: -76.4922 },
  "baltimore, md": { latitude: 39.2904, longitude: -76.6122 },
  "bel air, md": { latitude: 39.5359, longitude: -76.3483 },
  "churchville, md": { latitude: 39.5596, longitude: -76.2502 },
  "columbia, md": { latitude: 39.2037, longitude: -76.8610 },
  "frederick, md": { latitude: 39.4143, longitude: -77.4105 },
  "newark, de": { latitude: 39.6837, longitude: -75.7497 },
  "philadelphia, pa": { latitude: 39.9526, longitude: -75.1652 },
  "pittsburgh, pa": { latitude: 40.4406, longitude: -79.9959 },
  "washington, dc": { latitude: 38.9072, longitude: -77.0369 },
  "miami, fl": { latitude: 25.7617, longitude: -80.1918 },
  "orlando, fl": { latitude: 28.5383, longitude: -81.3792 },
  "tampa, fl": { latitude: 27.9506, longitude: -82.4572 },
  "los angeles, ca": { latitude: 34.0522, longitude: -118.2437 },
  "san diego, ca": { latitude: 32.7157, longitude: -117.1611 },
  "san francisco, ca": { latitude: 37.7749, longitude: -122.4194 },
  "citrus heights, ca": { latitude: 38.6929, longitude: -121.2880 },
};

const stateAliases: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia", kansas: "ks",
  kentucky: "ky", louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma",
  michigan: "mi", minnesota: "mn", mississippi: "ms", missouri: "mo", montana: "mt",
  nebraska: "ne", nevada: "nv", "new hampshire": "nh", "new jersey": "nj",
  "new mexico": "nm", "new york": "ny", "north carolina": "nc", "north dakota": "nd",
  ohio: "oh", oklahoma: "ok", oregon: "or", pennsylvania: "pa", "rhode island": "ri",
  "south carolina": "sc", "south dakota": "sd", tennessee: "tn", texas: "tx",
  utah: "ut", vermont: "vt", virginia: "va", washington: "wa", "west virginia": "wv",
  wisconsin: "wi", wyoming: "wy", "district of columbia": "dc",
};

function numericCoordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coordinatePair(listing: WatchListing): { latitude: number; longitude: number } | null {
  const directLatitude = numericCoordinate(listing.latitude ?? listing.location_latitude);
  const directLongitude = numericCoordinate(listing.longitude ?? listing.location_longitude);
  if (directLatitude !== null && directLongitude !== null) {
    return { latitude: directLatitude, longitude: directLongitude };
  }
  const nestedLatitude = numericCoordinate(listing.coordinates?.latitude);
  const nestedLongitude = numericCoordinate(listing.coordinates?.longitude);
  return nestedLatitude !== null && nestedLongitude !== null
    ? { latitude: nestedLatitude, longitude: nestedLongitude }
    : null;
}

function normalizedLocation(location: string): string {
  const normalized = location.trim().toLowerCase().replace(/\s+/g, " ").replace(/,\s*/g, ", ");
  const match = normalized.match(/^(.*),\s*([^,]+)$/);
  if (!match) return normalized;
  const state = stateAliases[match[2]] ?? match[2];
  return `${match[1]}, ${state}`;
}

function knownLocationCoordinates(location: string): { latitude: number; longitude: number } | null {
  const normalized = normalizedLocation(location);
  const exact = knownLocations[normalized];
  if (exact) return exact;
  for (const [name, coordinates] of Object.entries(knownLocations)) {
    if (normalized.includes(name)) return coordinates;
  }
  return null;
}

export function haversineDistanceKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = radians(to.latitude - from.latitude);
  const deltaLongitude = radians(to.longitude - from.longitude);
  const latitude = radians(from.latitude);
  const targetLatitude = radians(to.latitude);
  const value =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.sin(deltaLongitude / 2) ** 2 * Math.cos(latitude) * Math.cos(targetLatitude);
  return 6_371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function classifyDistance(listing: WatchListing): DistanceResult {
  const coordinates = coordinatePair(listing);
  const method = coordinates ? "coordinates" : "known_location";
  const usableCoordinates = coordinates ?? knownLocationCoordinates(listing.location);
  if (!usableCoordinates) return { status: "unverified", distanceKm: null, method: "unverified" };
  const distanceKm = haversineDistanceKm(WATCH_CENTER, usableCoordinates);
  return {
    status: distanceKm <= WATCH_RADIUS_KM ? "in_radius" : "out_of_radius",
    distanceKm: Math.round(distanceKm * 10) / 10,
    method,
  };
}

function priceValue(price: string): number | null {
  if (/\bfree\b/i.test(price)) return 0;
  if (/\btrade\b|obo|call for|contact/i.test(price)) return null;
  const match = price.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return match ? Number(match[1]) : null;
}

function hasMacTarget(text: string): boolean {
  return /mac\s+studio/.test(text) &&
    ((/m2\s+max/.test(text) && /96\s*gb/.test(text)) ||
      (/m2\s+ultra/.test(text) && /128\s*gb/.test(text)));
}

function hasProxmoxEvidence(text: string): boolean {
  return /i[3579][ -]?\d{4,5}|ryzen\s*[3579]\s*\d{4,5}|threadripper|xeon|ddr[45]|nvme|ssd|motherboard|cpu\s*(?:\+|and)\s*(?:ram|memory)|optiplex|thinkstation|z2\s*(?:tower|g[459])/i.test(text);
}

export function candidateScore(listing: WatchListing, kind: string): number {
  const text = listing.title.toLowerCase();
  if (/mount|stand|case|hub|display|monitor|software|service|parts only|laptop|bag|cover|cable/.test(text)) return -10;
  const price = priceValue(listing.price);
  if (price === null) return -10;
  if (kind === "mac") {
    if (!hasMacTarget(text) || price < 1_500 || price > 1_900) return -10;
    return 10;
  }
  if (kind !== "proxmox" || price > 1_000 || !hasProxmoxEvidence(text)) return -10;
  return price === 0 ? 9 : 6;
}

export function qualifiesAsLocalCandidate(
  listing: WatchListing,
  kind: string,
): boolean {
  const distance = classifyDistance(listing);
  return distance.status === "in_radius" && candidateScore(listing, kind) >= 0;
}
