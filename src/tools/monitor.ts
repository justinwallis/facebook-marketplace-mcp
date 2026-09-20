import type { z } from "zod/v4";
import { responseFor, takeWithinCharacterLimit } from "../mcp/response.js";
import { CHARACTER_LIMIT } from "../mcp/constants.js";
import type {
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
        sortBy: args.sort_by,
        deliveryMethod: args.delivery_method,
        dateListed: args.date_listed,
        limit: args.limit,
        maxPages: args.max_pages,
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
      }> = [];
      for (const monitor of monitors) {
        const search = await service.searchListings(monitor.params);
        const unseenListings = search.listings.filter(
          (listing) => !monitor.seenIds.includes(listing.id),
        );
        const isBaseline = monitor.lastChecked === null && monitor.seenIds.length === 0;
        store.updateSeenIds(
          monitor.name,
          unseenListings.map((listing) => listing.id),
        );
        results.push({
          name: monitor.name,
          found: true,
          new_listings: isBaseline ? [] : unseenListings.map(listingOutput),
        });
      }
      if (args.monitor_name && results.length === 0)
        results.push({
          name: args.monitor_name,
          found: false,
          new_listings: [],
        });
      const outputResults = results.map((result) => ({
        ...result,
        new_listings: [...result.new_listings],
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
          .find((result) => result.new_listings.length > 0);
        if (resultWithListings) {
          resultWithListings.new_listings.pop();
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
                : `## ${result.name}\n\n${result.new_listings.length ? result.new_listings.map((listing) => `- **${listing.title}** — ${listing.price}\n  ${listing.url}`).join("\n") : "No new listings."}`,
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
