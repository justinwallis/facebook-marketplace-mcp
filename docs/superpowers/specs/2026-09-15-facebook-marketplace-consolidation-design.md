# Facebook Marketplace Consolidation Design

## Goal
Use PR #4 as the reliable base, preserve its structured Relay parser, and add only the resilient behaviors from PR #5 that remain independently useful.

## Architecture
`FacebookClient` remains the direct GraphQL transport. Authentication resolves from an explicit saved session, the default saved session, or (only when neither is selected/present) macOS Chrome cookies. Search is page-oriented internally and can optionally traverse multiple cursors while deduplicating IDs. ID-only feed units become explicit hydration stubs and are hydrated from listing pages with a separate rate budget.

## Error model
A legitimate empty connection is success. Missing/malformed GraphQL data, invalid sessions, and parser/schema drift remain errors. Failed page hydration preserves an ID/URL stub with `needs_hydration=true` instead of dropping the listing.

## MCP surface
Keep PR #4 tool names/output schemas. Add bounded `max_pages` and expose `needs_hydration`. Monitors use a bounded three-page scan by default.

## Testing
Every added behavior has a regression test: skeleton feed parsing, pre-hydration limiting, cursor traversal/deduplication, Chrome display-name lookup, session-provider precedence, MCP pagination contract, and monitor scan depth.
