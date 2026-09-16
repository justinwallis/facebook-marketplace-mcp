# Handover

## Baseline
This branch starts from PR #4 head `0e1a4697af4f8272ac3be2e32199689cecdd3562` (`AKosmachyov/facebook-marketplace-mcp`) rather than upstream `master`.

## Incorporated work
- PR #4 retained: current 2026 GraphQL operations/request shapes, interactive saved-session auth, browser UA reuse, strict MCP schemas/output schemas, search filters, structured Relay JSON listing parser, diagnostics/raw capture, and regression tests.
- PR #5 selectively ported: `story_key` / `top_level_post_id` degraded-search recovery, listing-page hydration, local limit enforcement before hydration, separate page-fetch rate limiting, and Chrome profile display-name resolution.
- PR #1 was not applied separately because PR #4's structured Relay parser supersedes its regex title/description/seller fallbacks.

## Additional consolidation changes
- Saved session is preferred, with automatic Chrome-cookie fallback only when no explicit/default snapshot exists.
- `max_pages` (1–10, default 1) adds bounded cursor traversal with listing-ID deduplication.
- New monitors default to three pages / 72 listings per check.
- MCP output exposes `needs_hydration` so partial ID-only fallback results are explicit.


## Live E2E verification (2026-09-16)
- Authenticated login/session snapshot, location lookup, listing search, listing detail, two-/three-page pagination, and monitor persistence were exercised against live Facebook through the built MCP server.
- Added support for newline-delimited GraphQL `@defer` payloads observed on cursor pages.
- Marketplace bootstrap now uses the page-fetch limiter so three-page monitor checks do not hit the MCP 60-second timeout.
- Sponsored `MarketplaceFeedAdStory` nodes are excluded from degraded `story_key` fallback results.
- First monitor check now establishes a baseline instead of reporting all current inventory as new; large monitor responses are bounded while all discovered IDs are still persisted as seen.
- Chrome fallback auth errors now identify the Chrome profile instead of incorrectly referring to a session file.

## Known limitations
- Facebook may return more rows than requested. The client trims before hydration. A raw Facebook cursor cannot recover rows trimmed from the same server page; use a sufficiently large `limit` plus `max_pages` for scans.
- `LISTING_DETAIL_DOC_ID`, if configured later, still needs a dedicated normalized GraphQL detail parser; the current default detail path uses structured Relay JSON from the listing page.
- Marketplace operation IDs can rotate. Use `npm run capture-queries`, then update operation fixtures and IDs together.
- Monitor persistence still tracks seen IDs rather than content hashes, so price/title edits are not yet first-class change events.
