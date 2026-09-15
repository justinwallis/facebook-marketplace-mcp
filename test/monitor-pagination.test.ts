import assert from "node:assert/strict";
import test from "node:test";
import type { MonitorStore } from "../src/mcp/types.js";
import type { SavedMonitor, SearchParams } from "../src/facebook/types.js";
import { createCreateMonitorHandler } from "../src/tools/monitor.js";

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
