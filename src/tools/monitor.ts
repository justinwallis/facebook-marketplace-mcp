import type { z } from "zod/v4";
import { responseFor, takeWithinCharacterLimit } from "../mcp/response.js";
import { CHARACTER_LIMIT } from "../mcp/constants.js";
import type {
  MarketplaceListing,
  MarketplaceService,
  MonitorStore,
  SavedMonitor,
} from "../mcp/types.js";
import { toolErrorResponse } from "../utils/diagnostics.js";
import { listingOutput, monitorOutput } from "./shared.js";
import {
  checkMonitorsInput,
  createMonitorInput,
  deleteMonitorInput,
  listMonitorsInput,
} from "../mcp/contracts.js";

function monitorSnapshot(listing: MarketplaceListing) {
  return {
    id: listing.id,
    title: listing.title,
    price: listing.price,
    location: listing.location,
    isPending: listing.isPending,
  };
}

function listingChanges(
  previous: ReturnType<typeof monitorSnapshot>,
  current: ReturnType<typeof monitorSnapshot>,
) {
  const changes: Record<string, { from: string | boolean; to: string | boolean }> = {};
  if (previous.title !== current.title) changes.title = { from: previous.title, to: current.title };
  if (previous.price !== current.price) changes.price = { from: previous.price, to: current.price };
  if (previous.location !== current.location) changes.location = { from: previous.location, to: current.location };
  if (previous.isPending !== current.isPending) {
    changes.is_pending = { from: previous.isPending, to: current.isPending };
  }
  return changes;
}

export function createCreateMonitorHandler(store: MonitorStore) {
  return async (args: z.infer<typeof createMonitorInput>) => {
    try {
      const monitor = store.add(args.name, {
        query: args.query,
        latitude: args.latitude,
        longitude: args.longitude,
        radiusKm: args.radius_km,
        minPrice: args.min_price,
        maxPrice: args.max_price,
        category: args.category,
        sortBy: args.sort_by ?? "suggested",
        deliveryMethod: args.delivery_method ?? "all",
        dateListed: args.date_listed ?? "all",
        limit: args.limit ?? 72,
        maxPages: args.max_pages ?? 3,
      });
      const output = { monitor: monitorOutput(monitor) };
      return responseFor(
        output,
        args.response_format,
        `# Monitor saved\n\n**${monitor.name}** searches for "${monitor.params.query}" within ${monitor.params.radiusKm} km using ${monitor.params.deliveryMethod ?? "all"} delivery and up to ${monitor.params.maxPages ?? 1} page(s) per check.`,
      );
    } catch (error) {
      return toolErrorResponse(
        "facebook_marketplace_create_monitor",
        args,
        error,
        "Unable to create monitor",
      );
    }
  };
}

export function createCheckMonitorsHandler(
  service: MarketplaceService,
  store: MonitorStore,
) {
  return async (args: z.infer<typeof checkMonitorsInput>) => {
    try {
      const monitors = args.monitor_name
        ? [store.get(args.monitor_name)].filter(
            (monitor): monitor is SavedMonitor => Boolean(monitor),
          )
        : store.list();
      const results: Array<{
        name: string;
        found: boolean;
        new_listings: ReturnType<typeof listingOutput>[];
        updated_listings: Array<ReturnType<typeof listingOutput> & {
          changes: Record<string, { from: string | boolean; to: string | boolean }>;
        }>;
      }> = [];
      for (const monitor of monitors) {
        const search = await service.searchListings(monitor.params);
        const unseenListings = search.listings.filter(
          (listing) => !monitor.seenIds.includes(listing.id),
        );
        const snapshotsById = new Map(
          (monitor.listingSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]),
        );
        const updatedListings = search.listings
          .filter((listing) => monitor.seenIds.includes(listing.id))
          .map((listing) => {
            const previous = snapshotsById.get(listing.id);
            if (!previous) return undefined;
            const changes = listingChanges(previous, monitorSnapshot(listing));
            return Object.keys(changes).length
              ? { ...listingOutput(listing), changes }
              : undefined;
          })
          .filter((listing): listing is NonNullable<typeof listing> => Boolean(listing));
        const isBaseline = monitor.lastChecked === null && monitor.seenIds.length === 0;
        store.updateSeenIds(
          monitor.name,
          unseenListings.map((listing) => listing.id),
        );
        store.updateSnapshots?.(monitor.name, search.listings.map(monitorSnapshot));
        results.push({
          name: monitor.name,
          found: true,
          new_listings: isBaseline ? [] : unseenListings.map(listingOutput),
          updated_listings: isBaseline ? [] : updatedListings,
        });
      }
      if (args.monitor_name && results.length === 0)
        results.push({
          name: args.monitor_name,
          found: false,
          new_listings: [],
          updated_listings: [],
        });
      const outputResults = results.map((result) => ({
        ...result,
        new_listings: [...result.new_listings],
        updated_listings: [...result.updated_listings],
      }));
      let truncated = false;
      const makeOutput = () => ({
        count: outputResults.length,
        results: outputResults,
        truncated,
        ...(truncated
          ? {
              truncation_message:
                "Response truncated. All discovered listing IDs were still recorded as seen.",
            }
          : {}),
      });
      while (JSON.stringify(makeOutput(), null, 2).length > CHARACTER_LIMIT) {
        const resultWithListings = [...outputResults]
          .reverse()
          .find((result) => result.new_listings.length > 0 || result.updated_listings.length > 0);
        if (resultWithListings) {
          if (resultWithListings.new_listings.length > 0) resultWithListings.new_listings.pop();
          else resultWithListings.updated_listings.pop();
          truncated = true;
          continue;
        }
        if (outputResults.length > 1) {
          outputResults.pop();
          truncated = true;
          continue;
        }
        break;
      }
      const output = makeOutput();
      const markdown = output.results.length
        ? output.results
            .map((result) =>
              !result.found
                ? `## ${result.name}\n\nMonitor not found.`
                : `## ${result.name}\n\n${[
                    ...result.new_listings.map((listing) => `- **${listing.title}** — ${listing.price}\n  ${listing.url}`),
                    ...result.updated_listings.map((listing) => `- **Updated: ${listing.title}** — ${Object.keys(listing.changes).join(", ")}\n  ${listing.url}`),
                  ].join("\n") || "No new listings or listing changes."}`,
            )
            .join("\n\n")
        : "No monitors saved. Create one before checking for new listings.";
      return responseFor(output, args.response_format, markdown);
    } catch (error) {
      return toolErrorResponse(
        "facebook_marketplace_check_monitors",
        args,
        error,
        "Unable to check monitors",
      );
    }
  };
}

export function createDeleteMonitorHandler(store: MonitorStore) {
  return async (args: z.infer<typeof deleteMonitorInput>) => {
    try {
      const output = { name: args.name, deleted: store.delete(args.name) };
      return responseFor(
        output,
        args.response_format,
        output.deleted
          ? `Monitor "${args.name}" deleted.`
          : `Monitor "${args.name}" was not found.`,
      );
    } catch (error) {
      return toolErrorResponse(
        "facebook_marketplace_delete_monitor",
        args,
        error,
        "Unable to delete monitor",
      );
    }
  };
}

export function createListMonitorsHandler(store: MonitorStore) {
  return async (args: z.infer<typeof listMonitorsInput>) => {
    try {
      const bounded = takeWithinCharacterLimit(
        store.list().map(monitorOutput),
        (monitor) => JSON.stringify(monitor),
      );
      const output = {
        count: bounded.items.length,
        monitors: bounded.items,
        truncated: bounded.truncated,
        ...(bounded.truncated
          ? {
              truncation_message:
                "Response truncated. Delete inactive monitors or inspect monitor storage locally.",
            }
          : {}),
      };
      const markdown = bounded.items.length
        ? `# Saved monitors\n\n${bounded.items.map((monitor) => `- **${monitor.name}** — "${monitor.query}" (${monitor.radius_km} km)\n  Seen: ${monitor.seen_count} listings`).join("\n")}`
        : "No monitors saved.";
      return responseFor(output, args.response_format, markdown);
    } catch (error) {
      return toolErrorResponse(
        "facebook_marketplace_list_monitors",
        args,
        error,
        "Unable to list monitors",
      );
    }
  };
}
