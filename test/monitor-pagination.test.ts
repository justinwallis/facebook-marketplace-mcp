import assert from "node:assert/strict";
import test from "node:test";
import type { MarketplaceService, MonitorStore } from "../src/mcp/types.js";
import type { SavedMonitor, SearchParams } from "../src/facebook/types.js";
import {
  createCheckMonitorsHandler,
  createCreateMonitorHandler,
} from "../src/tools/monitor.js";
import { CHARACTER_LIMIT } from "../src/mcp/constants.js";

function saved(params: Omit<SearchParams, "cursor">): SavedMonitor {
  return {
    id: "monitor-1",
    name: "desks",
    params,
    seenIds: [],
    createdAt: "2026-09-15T00:00:00.000Z",
    lastChecked: null,
  };
}

test("new monitors scan three Marketplace pages by default", async () => {
  let received: Omit<SearchParams, "cursor"> | undefined;
  const store: MonitorStore = {
    add(_name, params) {
      received = params;
      return saved(params);
    },
    list: () => [],
    get: () => undefined,
    updateSeenIds: () => undefined,
    delete: () => false,
  };

  await createCreateMonitorHandler(store)({
    name: "desks",
    query: "desk",
    latitude: 52.4,
    longitude: 4.9,
    radius_km: 25,
    response_format: "json",
  });

  assert.equal(received?.maxPages, 3);
  assert.equal(received?.limit, 72);
});


function listing(id: string, title = `Desk ${id}`) {
  return {
    id,
    title,
    price: "€25",
    location: "Amsterdam",
    imageUrl: "https://example.test/image.jpg",
    sellerName: "Seller",
    postedDate: "2026-09-15T20:00:00.000Z",
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    isPending: false,
  };
}

test("first monitor check establishes a baseline without reporting existing listings as new", async () => {
  const monitor = saved({
    query: "desk",
    latitude: 52.4,
    longitude: 4.9,
    radiusKm: 25,
    limit: 72,
    maxPages: 3,
  });
  let updatedIds: string[] = [];
  const store: MonitorStore = {
    add: () => monitor,
    list: () => [monitor],
    get: () => monitor,
    updateSeenIds(_name, ids) { updatedIds = ids; },
    delete: () => false,
  };
  const service: MarketplaceService = {
    async searchListings() {
      return { listings: [listing("1"), listing("2")], hasNextPage: false, endCursor: null };
    },
    async getListingDetail() { throw new Error("not used"); },
    async searchLocation() { return []; },
  };

  const response = await createCheckMonitorsHandler(service, store)({
    monitor_name: "desks",
    response_format: "json",
  });

  assert.deepEqual(updatedIds, ["1", "2"]);
  assert.deepEqual(response.structuredContent.results[0].new_listings, []);
});

test("monitor checks truncate large new-listing payloads while marking every ID seen", async () => {
  const monitor = {
    ...saved({
      query: "desk",
      latitude: 52.4,
      longitude: 4.9,
      radiusKm: 25,
      limit: 72,
      maxPages: 3,
    }),
    lastChecked: "2026-09-15T20:00:00.000Z",
  };
  const allListings = Array.from({ length: 100 }, (_, index) =>
    listing(String(index + 1), `Desk ${index + 1} ${"x".repeat(500)}`),
  );
  let updatedIds: string[] = [];
  const store: MonitorStore = {
    add: () => monitor,
    list: () => [monitor],
    get: () => monitor,
    updateSeenIds(_name, ids) { updatedIds = ids; },
    delete: () => false,
  };
  const service: MarketplaceService = {
    async searchListings() {
      return { listings: allListings, hasNextPage: false, endCursor: null };
    },
    async getListingDetail() { throw new Error("not used"); },
    async searchLocation() { return []; },
  };

  const response = await createCheckMonitorsHandler(service, store)({
    monitor_name: "desks",
    response_format: "json",
  });

  assert.equal(updatedIds.length, 100);
  assert.equal(response.structuredContent.truncated, true);
  assert.ok(response.structuredContent.results[0].new_listings.length < 100);
  assert.ok(response.content[0].text.length <= CHARACTER_LIMIT);
});
