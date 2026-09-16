import type {
  FacebookSession,
  SearchParams,
  SearchResult,
  MarketplaceListingDetail,
} from "./types.js";
import {
  cookiesToHeader,
  getCookieValue,
  loadFacebookSessionFlexible,
} from "./auth.js";
import {
  MARKETPLACE_SEARCH_DOC_ID,
  LOCATION_SEARCH_DOC_ID,
  LISTING_DETAIL_DOC_ID,
  buildSearchVariables,
  buildLocationSearchVariables,
} from "./queries.js";
import { parseSearchResponse, parseListingDetailFromPage } from "./parser.js";
import { captureListingPageHtml } from "./raw-capture.js";
import { RateLimiter } from "../utils/rate-limit.js";
import {
  MarketplaceRequestError,
  recordGraphqlWarning,
  type FacebookRequestContext,
} from "../utils/diagnostics.js";

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const MARKETPLACE_URL = "https://www.facebook.com/marketplace/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphqlErrorSummary(response: Record<string, unknown>) {
  const errors = Array.isArray(response.errors)
    ? [...response.errors]
    : response.errors != null
      ? [response.errors]
      : [];
  if (
    response.error != null &&
    response.error !== false &&
    response.error !== 0
  ) {
    errors.push(response.error);
  }
  const codes: number[] = [];
  for (const error of errors) {
    const candidates = isRecord(error)
      ? [
          error.code,
          error.error_code,
          isRecord(error.extensions) ? error.extensions.code : undefined,
        ]
      : [error];
    for (const code of candidates) {
      if (typeof code === "number" && Number.isFinite(code)) codes.push(code);
    }
  }
  return { errorCount: errors.length, codes };
}

function stripFacebookJsonPrefix(text: string): string {
  return text.replace(/^\s*for\s*\(;;\);\s*/, "");
}

function parseGraphqlPayloads(text: string): unknown[] {
  const stripped = stripFacebookJsonPrefix(text);
  try {
    return [JSON.parse(stripped)];
  } catch (singleError) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 1) throw singleError;
    return lines.map((line) => JSON.parse(stripFacebookJsonPrefix(line)));
  }
}

const BROWSER_HEADERS: Record<string, string> = {
  "Accept-Language": "en-US,en;q=0.9",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "Upgrade-Insecure-Requests": "1",
};

export class FacebookClient {
  private session: FacebookSession | null = null;
  private rateLimiter: RateLimiter;
  private pageRateLimiter: RateLimiter;
  private reqCounter = 0;
  private sessionFile?: string;
  private chromeProfile?: string;
  private userAgent = "";

  constructor(
    options: {
      maxRequestsPerMinute?: number;
      maxPageFetchesPerMinute?: number;
      sessionFile?: string;
      chromeProfile?: string;
    } = {},
  ) {
    this.rateLimiter = new RateLimiter(options.maxRequestsPerMinute ?? 3);
    this.pageRateLimiter = new RateLimiter(options.maxPageFetchesPerMinute ?? 30);
    this.sessionFile = options.sessionFile;
    this.chromeProfile = options.chromeProfile;
  }

  async ensureSession(): Promise<FacebookSession> {
    if (this.session) return this.session;
    return this.initSession();
  }

  private async fetchFacebook(
    url: string,
    init: RequestInit,
    request: FacebookRequestContext,
  ): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new MarketplaceRequestError(
        "Facebook request could not be completed",
        request,
        {
          cause: error,
        },
      );
    }
  }

  async initSession(): Promise<FacebookSession> {
    const { cookies, userAgent } = loadFacebookSessionFlexible({
      sessionFile: this.sessionFile,
      chromeProfile: this.chromeProfile,
    });

    if (cookies.length === 0) {
      throw new Error(
        "No Facebook cookies found. Provide a valid FACEBOOK_SESSION_FILE or run npm run login.",
      );
    }

    const userId = getCookieValue(cookies, "c_user");
    if (!userId) {
      throw new Error(
        "No c_user cookie found. Provide a valid FACEBOOK_SESSION_FILE or run npm run login.",
      );
    }

    this.userAgent = userAgent ?? USER_AGENT;
    const cookieHeader = cookiesToHeader(cookies);

    // Fetch marketplace page to extract tokens
    const tokens = await this.extractTokens(cookieHeader);

    this.session = {
      cookies,
      cookieHeader,
      userId,
      ...tokens,
    };

    return this.session;
  }

  private async extractTokens(cookieHeader: string): Promise<{
    fbDtsg: string;
    lsd: string;
    jazoest: string;
    clientRevision: string;
  }> {
    await this.pageRateLimiter.wait();

    const request = {
      operation: "marketplace-bootstrap" as const,
      method: "GET" as const,
      path: "/marketplace/",
    };
    const res = await this.fetchFacebook(
      MARKETPLACE_URL,
      {
        headers: {
          ...BROWSER_HEADERS,
          "User-Agent": this.userAgent,
          Cookie: cookieHeader,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        },
        redirect: "follow",
      },
      request,
    );

    if (!res.ok) {
      throw new MarketplaceRequestError(
        `Failed to fetch marketplace page: ${res.status} ${res.statusText}`,
        { ...request, status: res.status },
      );
    }

    const html = await res.text();

    // Extract fb_dtsg from DTSGInitData or DTSGInitialData
    const dtsgMatch =
      html.match(/"DTSGInitData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/) ??
      html.match(
        /"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/,
      ) ??
      html.match(/"dtsg"\s*:\s*\{"token"\s*:\s*"([^"]+)"/);

    if (!dtsgMatch) {
      throw new MarketplaceRequestError(
        "Failed to extract Facebook page tokens. Session may be expired — run npm run login.",
        { ...request, responseBytes: html.length },
      );
    }
    const fbDtsg = dtsgMatch[1];

    // Extract jazoest
    const jazoestMatch = html.match(/jazoest=(\d+)/);
    const jazoest = jazoestMatch ? jazoestMatch[1] : "";

    // Extract lsd
    const lsdMatch =
      html.match(/"LSD"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/) ??
      html.match(/name="lsd"\s+value="([^"]+)"/);
    const lsd = lsdMatch ? lsdMatch[1] : "";

    // Extract client revision
    const revMatch =
      html.match(/"client_revision"\s*:\s*(\d+)/) ??
      html.match(/__spin_r:\s*(\d+)/);
    const clientRevision = revMatch ? revMatch[1] : "1";

    return { fbDtsg, lsd, jazoest, clientRevision };
  }

  private async graphqlRequest(
    docId: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const session = await this.ensureSession();
    await this.rateLimiter.wait();

    this.reqCounter++;

    const body = new URLSearchParams({
      fb_dtsg: session.fbDtsg,
      lsd: session.lsd,
      jazoest: session.jazoest,
      doc_id: docId,
      variables: JSON.stringify(variables),
      __a: "1",
      __req: this.reqCounter.toString(36),
      __rev: session.clientRevision,
    });

    const request = {
      operation: "graphql" as const,
      method: "POST" as const,
      path: "/api/graphql/",
      docId,
    };
    const res = await this.fetchFacebook(
      GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          "User-Agent": this.userAgent,
          Cookie: session.cookieHeader,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "*/*",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          Origin: "https://www.facebook.com",
          Referer: "https://www.facebook.com/marketplace/",
          "X-FB-LSD": session.lsd,
        },
        body: body.toString(),
      },
      request,
    );

    if (res.status === 401 || res.status === 403) {
      // Session expired — clear and retry once
      this.session = null;
      throw new MarketplaceRequestError(
        "Session expired. Re-initializing on next request.",
        {
          ...request,
          status: res.status,
        },
      );
    }

    if (!res.ok) {
      throw new MarketplaceRequestError(
        `GraphQL request failed: ${res.status} ${res.statusText}`,
        { ...request, status: res.status },
      );
    }

    const text = await res.text();
    const context = {
      ...request,
      status: res.status,
      responseBytes: Buffer.byteLength(text, "utf8"),
    };
    let payloads: unknown[];
    try {
      payloads = parseGraphqlPayloads(text);
    } catch {
      throw new MarketplaceRequestError(
        "Failed to parse GraphQL response",
        context,
      );
    }
    const data = payloads[0];
    if (!isRecord(data)) {
      throw new MarketplaceRequestError(
        "Invalid GraphQL response envelope",
        context,
      );
    }
    const summaries = payloads
      .filter(isRecord)
      .map((payload) => graphqlErrorSummary(payload));
    const summary = {
      errorCount: summaries.reduce((total, item) => total + item.errorCount, 0),
      codes: summaries.flatMap((item) => item.codes),
    };
    if (summary.errorCount > 0) {
      await recordGraphqlWarning(context, summary);
    }
    if (!isRecord(data.data)) {
      throw new MarketplaceRequestError(
        summary.errorCount > 0
          ? "Facebook returned GraphQL errors without usable data"
          : "GraphQL response is missing usable data",
        context,
      );
    }
    return data;
  }

  async searchListings(params: SearchParams): Promise<SearchResult> {
    const maxPages = Math.max(1, Math.floor(params.maxPages ?? 1));
    if (maxPages === 1) return this.searchListingsPage(params);

    const listings: SearchResult["listings"] = [];
    const seenIds = new Set<string>();
    let cursor = params.cursor;
    let hasNextPage = false;
    let endCursor: string | null = null;

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      const page = await this.searchListingsPage(
        {
          ...params,
          cursor,
          maxPages: 1,
        },
        {
          excludeIds: seenIds,
          maxResults: Math.max(1, params.limit - listings.length),
        },
      );
      for (const listing of page.listings) {
        if (seenIds.has(listing.id)) continue;
        seenIds.add(listing.id);
        listings.push(listing);
        if (listings.length >= params.limit) break;
      }

      hasNextPage = page.hasNextPage;
      endCursor = page.endCursor;
      if (listings.length >= params.limit) break;
      if (!page.hasNextPage || !page.endCursor) break;
      cursor = page.endCursor;
    }

    return { listings, hasNextPage, endCursor };
  }

  private async searchListingsPage(
    params: SearchParams,
    options: {
      excludeIds?: ReadonlySet<string>;
      maxResults?: number;
    } = {},
  ): Promise<SearchResult> {
    const variables = buildSearchVariables(params);
    const data = await this.graphqlRequest(
      MARKETPLACE_SEARCH_DOC_ID,
      variables,
    );
    try {
      const result = parseSearchResponse(data);

      if (options.excludeIds?.size) {
        result.listings = result.listings.filter(
          (listing) => !options.excludeIds!.has(listing.id),
        );
      }
      const maxResults = options.maxResults ?? params.limit;
      if (maxResults > 0 && result.listings.length > maxResults) {
        result.listings = result.listings.slice(0, maxResults);
        result.hasNextPage = true;
      }

      for (const listing of result.listings) {
        if (!listing.needsHydration) continue;
        try {
          const detail = await this.fetchListingPage(listing.id);
          listing.title = detail.title;
          listing.price = detail.price || "N/A";
          listing.location = detail.location || "Unknown";
          listing.imageUrl = detail.imageUrl;
          listing.sellerName = detail.sellerName || "Unknown";
          listing.postedDate = detail.postedDate;
          listing.isPending = detail.isPending;
          delete listing.needsHydration;
        } catch {
          // Keep the explicit hydration marker: the ID/URL remain useful and
          // callers can distinguish a partial result from a fully parsed one.
        }
      }

      return result;
    } catch (error) {
      if (error instanceof MarketplaceRequestError) throw error;
      throw new MarketplaceRequestError(
        "Failed to parse Marketplace search response",
        {
          operation: "graphql",
          method: "POST",
          path: "/api/graphql/",
          docId: MARKETPLACE_SEARCH_DOC_ID,
        },
        { cause: error },
      );
    }
  }

  async getListingDetail(listingId: string): Promise<MarketplaceListingDetail> {
    // If we have a doc_id for listing detail, use GraphQL
    if (LISTING_DETAIL_DOC_ID) {
      const data = await this.graphqlRequest(LISTING_DETAIL_DOC_ID, {
        targetId: listingId,
      });
      // Parse response (would need a dedicated parser)
      return data as MarketplaceListingDetail;
    }

    // Fallback: fetch the listing page directly and parse embedded data
    return this.fetchListingPage(listingId);
  }

  private async fetchListingPage(
    listingId: string,
  ): Promise<MarketplaceListingDetail> {
    const session = await this.ensureSession();
    await this.pageRateLimiter.wait();

    const url = `https://www.facebook.com/marketplace/item/${listingId}/`;
    const request = {
      operation: "listing-page" as const,
      method: "GET" as const,
      path: "/marketplace/item/:listingId/",
    };
    const res = await this.fetchFacebook(
      url,
      {
        headers: {
          ...BROWSER_HEADERS,
          "User-Agent": this.userAgent,
          Cookie: session.cookieHeader,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        },
        redirect: "follow",
      },
      request,
    );

    // Capture before examining the response so opted-in diagnostics retain
    // successful pages as well as login, block, and error pages.
    const html = await res.text();
    await captureListingPageHtml(listingId, html);

    if (!res.ok) {
      throw new MarketplaceRequestError(
        `Failed to fetch listing ${listingId}: ${res.status}`,
        {
          ...request,
          status: res.status,
        },
      );
    }

    try {
      return parseListingDetailFromPage(html, listingId);
    } catch (error) {
      throw new MarketplaceRequestError(
        "Failed to parse listing response",
        {
          ...request,
          responseBytes: html.length,
        },
        { cause: error },
      );
    }
  }

  async searchLocation(
    query: string,
    viewerCoordinates?: { latitude: number; longitude: number },
  ): Promise<Array<{ name: string; latitude: number; longitude: number }>> {
    const variables = buildLocationSearchVariables(query, viewerCoordinates);
    const data = await this.graphqlRequest(LOCATION_SEARCH_DOC_ID, variables);

    try {
      if (!isRecord(data) || !isRecord(data.data)) {
        throw new Error("Marketplace location response is missing data");
      }
      const citySearch = data.data.city_street_search;
      if (!isRecord(citySearch) || !isRecord(citySearch.street_results)) {
        throw new Error("Marketplace location response is missing street results");
      }
      const edges = citySearch.street_results.edges;
      if (!Array.isArray(edges)) {
        throw new Error("Marketplace location response has invalid edges");
      }

      const locations = edges.flatMap((edge) => {
        if (!isRecord(edge) || !isRecord(edge.node)) return [];
        const location = edge.node.location;
        if (!isRecord(location)) return [];
        const latitude = location.latitude;
        const longitude = location.longitude;
        if (
          typeof latitude !== "number" ||
          !Number.isFinite(latitude) ||
          typeof longitude !== "number" ||
          !Number.isFinite(longitude)
        ) {
          return [];
        }
        const name =
          typeof edge.node.single_line_address === "string"
            ? edge.node.single_line_address
            : typeof edge.node.subtitle === "string"
              ? edge.node.subtitle
              : "Unknown";
        return [{ name, latitude, longitude }];
      });
      if (edges.length > 0 && locations.length === 0) {
        throw new Error("Marketplace location response contains no usable locations");
      }
      return locations;
    } catch (error) {
      throw new MarketplaceRequestError(
        "Failed to parse Marketplace location response",
        {
          operation: "graphql",
          method: "POST",
          path: "/api/graphql/",
          docId: LOCATION_SEARCH_DOC_ID,
        },
        { cause: error },
      );
    }
  }

  clearSession() {
    this.session = null;
    this.reqCounter = 0;
  }
}
