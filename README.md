# Facebook Marketplace MCP Server

An MCP server that provides access to Facebook Marketplace via direct GraphQL API calls. No browser automation at runtime — speaks Facebook's internal protocol directly.

This consolidated fork keeps the server **read-only toward Facebook** while adding safer local session handling, bounded native listing-image inspection, and richer saved-monitor filters intended for low-frequency deal watching. See [docs/marketplace-watch.md](docs/marketplace-watch.md) for a scheduler-agnostic watcher pattern and [FORK_NOTES.md](FORK_NOTES.md) for provenance and design choices.

## How It Works

Facebook's web client makes all Marketplace requests as `POST /api/graphql/` with a `doc_id` (query hash) and `variables`. This server replays those requests using either a saved interactive-login session or your existing Facebook session cookies from Chrome.

**Think of it like [pypush](https://github.com/JJTech0130/pypush) for iMessage — direct protocol, no browser.**

## Prerequisites

- **macOS** for automatic Chrome-cookie fallback (interactive session files are portable)
- **Google Chrome** for `npm run login` or automatic cookie extraction
- **Node.js** 22+

## Installation

```bash
git clone <this-repo>
cd facebook-marketplace-mcp
npm install
npm run build
```

## Setup with Claude Code

```bash
claude mcp add facebook-marketplace -- node /path/to/facebook-marketplace-mcp/dist/index.js
```

Or add to your Claude Code config manually:

```json
{
  "mcpServers": {
    "facebook-marketplace": {
      "command": "node",
      "args": ["/path/to/facebook-marketplace-mcp/dist/index.js"],
      "env": {
        "FACEBOOK_SESSION_FILE": "/absolute/path/to/facebook-marketplace-mcp/.local/facebook-session.json"
      }
    }
  }
}
```

## Setup with Codex

```toml
[mcp_servers.facebook-marketplace]
command = "node"
args = ["/path/to/facebook-marketplace-mcp/dist/index.js"]

[mcp_servers.facebook-marketplace.env]
"FACEBOOK_SESSION_FILE" = "/absolute/path/to/facebook-marketplace-mcp/.local/facebook-session.json"

```

## Tools

### `facebook_marketplace_search_listings`

Search Marketplace by query, location, and filters.

| Parameter         | Type   | Required | Description                                                                                   |
| ----------------- | ------ | -------- | --------------------------------------------------------------------------------------------- |
| `query`           | string | yes      | Search term                                                                                   |
| `latitude`        | number | yes      | Latitude of search center                                                                     |
| `longitude`       | number | yes      | Longitude of search center                                                                    |
| `radius_km`       | number | no       | Search radius (default: 50)                                                                   |
| `min_price`       | number | no       | Min price in dollars                                                                          |
| `max_price`       | number | no       | Max price in dollars                                                                          |
| `category`        | string | no       | Category ID                                                                                   |
| `sort_by`         | string | no       | `suggested` (default), `distance`, `date_listed`, `price_low_to_high`, or `price_high_to_low` |
| `delivery_method` | string | no       | `all` (default), `local_pickup`, or `shipping`                                                |
| `date_listed`     | string | no       | `all` (default), `last_24_hours`, `last_7_days`, or `last_30_days`                            |
| `limit`           | number | no       | Max total results (default: 20)                                                               |
| `max_pages`       | number | no       | GraphQL pages to scan automatically, 1–10 (default: 1)                                        |
| `cursor`          | string | no       | Continue from a cursor returned by a prior search                                             |

### `facebook_marketplace_get_listing`

Get full details for a specific listing.

| Parameter    | Type   | Required | Description            |
| ------------ | ------ | -------- | ---------------------- |
| `listing_id` | string | yes      | Marketplace listing ID |

### `facebook_marketplace_get_listing_images`

Return selected listing photos as native MCP image content for visual inspection. The tool accepts only HTTPS Facebook CDN image URLs, caps each image at 10 MB, allows at most 10 requested images, and does not follow redirects.

| Parameter       | Type     | Required | Description                                      |
| --------------- | -------- | -------- | ------------------------------------------------ |
| `listing_id`    | string   | yes      | Marketplace listing ID                           |
| `image_numbers` | number[] | no       | Specific 1-based photo numbers, maximum 10       |
| `max_images`    | number   | no       | First N photos when image_numbers is omitted (4) |

### `facebook_marketplace_search_locations`

Look up a city, neighborhood, or ZIP code to get coordinates for
`search_listings`.

| Parameter | Type   | Required | Description                                   |
| --------- | ------ | -------- | --------------------------------------------- |
| `query`   | string | yes      | Location text, such as `Boston MA` or `02108` |

### `facebook_marketplace_create_monitor`

Save a search as a monitor to track new listings over time.

| Parameter         | Type   | Required | Description                                                        |
| ----------------- | ------ | -------- | ------------------------------------------------------------------ |
| `name`            | string | yes      | Monitor name                                                       |
| `query`           | string | yes      | Search term                                                        |
| `latitude`        | number | yes      | Search center latitude                                             |
| `longitude`       | number | yes      | Search center longitude                                            |
| `radius_km`       | number | no       | Radius (default: 50)                                               |
| `min_price`       | number | no       | Minimum price                                                      |
| `max_price`       | number | no       | Maximum price                                                      |
| `category`        | string | no       | Marketplace category ID                                            |
| `sort_by`         | string | no       | Search sort used on each check (default: suggested)                |
| `delivery_method` | string | no       | all, local_pickup, or shipping (default: all)                      |
| `date_listed`     | string | no       | all, last_24_hours, last_7_days, or last_30_days                   |
| `limit`           | number | no       | Maximum unique listings inspected per check (default: 72)          |
| `max_pages`       | number | no       | Marketplace pages scanned per check, 1–10 (default: 3)             |

### `facebook_marketplace_check_monitors`

Check monitors for new listings since last check.

| Parameter      | Type   | Required | Description                             |
| -------------- | ------ | -------- | --------------------------------------- |
| `monitor_name` | string | no       | Check specific monitor, or omit for all |

### `facebook_marketplace_list_monitors`

List all saved monitors.

### `facebook_marketplace_delete_monitor`

Delete a saved monitor.

## Configuration

| Env Variable               | Default                        | Description                                                 |
| -------------------------- | ------------------------------ | ----------------------------------------------------------- |
| `FACEBOOK_SESSION_FILE`        | unset                          | Explicit login-session snapshot path; invalid explicit paths fail closed |
| `CHROME_PROFILE`               | `Default`                      | Chrome profile directory or display name for cookie fallback |
| `MAX_PAGE_FETCHES_PER_MINUTE`  | `30`                           | Separate budget for listing-page hydration requests          |
| `MCP_ERROR_LOG_PATH`           | `.local/mcp-errors.jsonl`      | Alternate path for sanitized failed-tool diagnostics         |
| `MCP_CAPTURE_LISTING_HTML`     | unset                          | Set to `1` to retain exact direct listing-page HTML locally  |
| `MCP_LISTING_CAPTURE_DIR`      | `.local/listing-page-captures` | Alternate directory for opted-in raw HTML captures           |

### Failed-request diagnostics

Every failed MCP tool call is appended as a JSON line to
`.local/mcp-errors.jsonl`. The error returned by the tool includes a
`diagnostic ID`; search the file for that ID to inspect the matching record.
Set `MCP_ERROR_LOG_PATH` when the log should live elsewhere.

Records include the timestamp, tool, bounded input summary, error type/message,
and safe Facebook request metadata such as the operation, path, status, and
GraphQL document ID. They never include cookies, authorization or CSRF values,
page tokens, request bodies, raw headers, HTML, or response bodies. The server
continues returning the original MCP tool error if diagnostic writing fails.

### Opt-in raw listing-page captures

Set `MCP_CAPTURE_LISTING_HTML=1` to save the exact HTML response from every
direct listing-page request, including successful, login, block, and error
pages. Captures are written before response status handling and parsing, so
they can be compared later when Facebook markup changes.

Raw captures are separate from `mcp-errors.jsonl`, never appear in MCP output,
and are stored as `0600` files in a `0700` directory. They can contain private
Facebook page data, are not pruned automatically, and must not be committed or
shared. Set `MCP_LISTING_CAPTURE_DIR` to use another protected local directory;
remove captures manually when they are no longer needed. A capture-write failure
is reported only on stderr and does not alter the request result.

### Authentication precedence

`npm run login` is the preferred setup. It saves normalized Facebook cookies and
the exact browser user agent to `.local/facebook-session.json`. If
`FACEBOOK_SESSION_FILE` is set, that file is used strictly and a missing or invalid
file is an error. Otherwise the server uses `.local/facebook-session.json` when it
exists; if it does not, macOS falls back to extracting the active Chrome profile's
Facebook cookies. `CHROME_PROFILE` accepts either an on-disk name such as
`Profile 2` or Chrome's visible profile name.

### Interactive login

When the session must be refreshed, run:

```bash
npm run login
```

This opens a visible, dedicated Chrome profile at
`.local/facebook-login-profile`. Complete Facebook login (including any
checkpoint), return to Marketplace, and press Enter in the terminal. The
command validates the Marketplace page and saves normalized cookies and the browser user agent to
`FACEBOOK_SESSION_FILE` or `.local/facebook-session.json`; page tokens are not
stored. It closes Chrome when it succeeds or fails, while retaining the private
login profile for the next interactive refresh.

The server writes snapshots atomically with owner-only directory and file
permissions, and refuses to overwrite symbolic links. Keep the file out of
version control. If it is missing, malformed, or expired, run `npm run login` again. Restart the
MCP server afterward to load the new cookies and browser user agent.

## Updating GraphQL Queries

Facebook rotates their `doc_id` values on deploys. If searches stop working:

```bash
npm install -D playwright
npx playwright install chromium
npm run capture-queries
```

This opens a browser, navigates Marketplace, and captures current query IDs. Update `src/facebook/queries.ts` with the new values.

## Verification

```bash
npm test
npm run build
```

### MCP Inspector

Use the Inspector's browser interface to explore and invoke the local stdio
server:

```bash
npm run inspector
```

## Rate Limiting

GraphQL traffic is self-rate-limited to 3 requests/minute with random jitter. Listing-page hydration has a separate 30 requests/minute budget, configurable with `MAX_PAGE_FETCHES_PER_MINUTE`. If a search operation degrades to ID-only `story_key` nodes, the server preserves them and hydrates only the listings that will actually be returned.

## Coverage and fallback behavior

- `max_pages` performs bounded cursor traversal, deduplicates listing IDs, and stops at the requested total `limit`, page bound, or Facebook end-of-results.
- New monitors scan up to 3 pages / 72 unique listings per check instead of only the first page.
- `needs_hydration` in MCP listing output is `true` only when Facebook returned an ID-only result and the listing-page fallback could not fill its fields.
- Facebook can ignore a small requested `count` and return a larger fixed page. The client enforces `limit` before expensive hydration. If you manually request a very small single page and then follow Facebook's raw cursor, items trimmed from that server page are not recoverable from that cursor; prefer a larger `limit` with `max_pages` for complete scans.

## Deal-watcher pattern

The MCP does not schedule itself. A persistent scheduler or agent should call `facebook_marketplace_check_monitors` at a modest cadence, triage only the newly returned listings, and optionally call `facebook_marketplace_get_listing` / `facebook_marketplace_get_listing_images` for promising or poorly described results.

The first monitor check establishes a baseline and returns no "new" inventory. This avoids a notification storm when a watch is created. See [docs/marketplace-watch.md](docs/marketplace-watch.md) for the recommended flow. A reusable agent playbook is also included at [skills/marketplace-watch/SKILL.md](skills/marketplace-watch/SKILL.md).

## Limitations

- **macOS only** for automatic Chrome-cookie extraction
- **Requires Chrome** with active Facebook session
- **Facebook ToS** — automating Facebook violates their Terms of Service
- **Fragile** — `doc_id` values change on Facebook deploys
- **Rate limited** — aggressive use may trigger CAPTCHAs or account flags
- **No write operations** — search/read only, no messaging or listing creation
