import type {
  MarketplaceListing,
  MarketplaceListingDetail,
  SavedMonitor,
  MonitorListingSnapshot,
  SearchParams,
  SearchResult,
} from "../facebook/types.js";

export interface MarketplaceService {
  searchListings(params: SearchParams): Promise<SearchResult>;
  getListingDetail(listingId: string): Promise<MarketplaceListingDetail>;
  searchLocation(
    query: string,
  ): Promise<Array<{ name: string; latitude: number; longitude: number }>>;
}

export interface MonitorStore {
  add(name: string, params: Omit<SearchParams, "cursor">): SavedMonitor;
  list(): SavedMonitor[];
  get(name: string): SavedMonitor | undefined;
  updateSeenIds(name: string, newIds: string[]): void;
  /** Optional for compatibility with stores implemented before snapshots existed. */
  updateSnapshots?(name: string, snapshots: MonitorListingSnapshot[]): void;
  delete(name: string): boolean;
}

export type { MarketplaceListing, MarketplaceListingDetail, SavedMonitor };
