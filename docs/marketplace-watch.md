# Marketplace Watcher Pattern

The MCP server stores monitor definitions and seen listing IDs, but it intentionally does not run a background scheduler. Use a persistent local scheduler or agent to call the MCP at a modest cadence.

## Recommended flow

1. Resolve the target area with `facebook_marketplace_search_locations`.
2. Create one or more monitors with short search phrases. Broad categories usually benefit from several queries because seller titles are inconsistent.
3. Run `facebook_marketplace_check_monitors` once to establish the baseline. Existing inventory is marked as seen and is not reported as new.
4. On later checks, cheaply triage only the newly returned listings by title, price, location, and obvious exclusions.
5. For plausible or poorly described listings, call `facebook_marketplace_get_listing`.
6. When photos matter, call `facebook_marketplace_get_listing_images` for selected images and let a vision-capable client inspect them.
7. Notify the human only for candidates that survive triage. Do not auto-message sellers.
8. Keep durable notes outside the MCP only when the listing is genuinely important.

## Example monitor shapes

A higher-spec workstation watch might use several overlapping queries:

- `Mac Studio`
- `M2 Max`
- `Apple Studio computer`

A bulk building-material watch might use broader queries:

- `red brick`
- `used brick`
- `reclaimed brick`
- `old bricks`
- `leftover masonry`

For local acquisition, use `delivery_method: "local_pickup"`. For categories where asking price should not hide negotiable inventory, omit `max_price`.

## Cadence

Start conservatively. A 15- to 30-minute interval is usually more appropriate than minute-by-minute polling for local classified listings. Increase or reduce the cadence only after observing reliability and account behavior.

The GraphQL client has its own request-rate limiter, but that does not remove the need for a conservative outer schedule.

## Post-result radius and candidate filtering

The hardware watcher enforces the documented Churchville center (`39.56, -76.25`) and 80 km radius after Marketplace results return. It prefers listing coordinate fields if the MCP supplies them; otherwise it estimates from a small conservative city/state map. Listings outside the radius remain in `rawListings` for auditability but are marked `out of radius` and cannot enter the ChatGPT alert candidate list. Missing or unknown locations are marked `distance unverified`, remain raw-only, and are never presented as local deals.

Candidate alerts also apply the documented hardware rubric: Mac Studio alerts require the M2 Max 96 GB target or the exceptional M2 Ultra 128 GB comparison target and a $1,500–$1,900 asking price; Proxmox alerts require free/low-cost pricing (with ambiguous placeholder/trade prices excluded) plus evidence of a reusable modern x86 platform, compatible memory, motherboard/CPU, or healthy SSD. The documented Proxmox budget is **$1,000 all-in for the build**, not a claim that any one listing is a budget-fit build. The dashboard distinguishes a **complete computer candidate** (CPU/platform, RAM, and storage evidence, plus a stated GPU when relevant) from a **complete Proxmox build**. A single computer listing is not labeled as a complete build: the dashboard separately reports asking price, whether that asking price is below the total budget, additional parts/upgrades, total build cost (unknown unless the report prices all required parts), and whether the 128 GB RAM target, full component compatibility, working condition, and target GPU are met, missing, or unverified. Components and incomplete systems remain separate. Accessories, laptops, services, parts-only listings, and unrelated results are excluded. This is an estimate from returned listing data, not a guarantee of pickup location or compatibility; details are still required before acting.

Hardware Watch report snapshots now use `rawListings` as the complete comparable returned-listing snapshot, including on the first run; `newListings` remains a compatibility field for qualifying IDs that were not already in watcher state. Reports also record `newSincePreviousSnapshot`, explicit disappearance/reappearance ID lists, and `newlyPostedListings: null` with an unavailable status because an ID difference is not proof that Marketplace newly posted an item. The dashboard labels these separately. Marketplace result rotation is expected: listings may disappear from a bounded result set and later reappear without being newly posted. Price or title changes are observable listing changes, not necessarily new listings. Synthetic records whose IDs contain `IN_MEMORY_MARKETPLACE_FEED_STORY_ENT` are preserved in raw reports for diagnosis only and are excluded from genuine listing counts, ID comparisons, reappearance calculations, and dashboard totals. A warning is shown when `deduplicatedListingCount` disagrees with the stored comparable snapshot length. Report retention is separate from listing-ID history: retaining or pruning report files does not establish that a listing is new, posted, disappeared, or available.

## Triage rubric

Keep the monitor broad and put most judgment in the triage layer. Useful signals include:

- unusually low asking price;
- large quantity or "take all" language;
- poor or vague title paired with promising photos;
- relevant model/specification details in the description;
- distance and pickup practicality;
- pending/sold state;
- signs that the listing is miscategorized, incomplete, or suspicious.

Do not assume an empty search is definitive. Facebook can rotate persisted-query IDs or change response shapes. If previously productive monitors suddenly return nothing, inspect diagnostics and refresh captured query IDs before concluding there is no inventory.

## Scheduling options

Any scheduler capable of invoking an MCP client can drive this pattern: a local agent, OpenClaw, launchd, cron, a long-running service, or another private task runner. Keep the Facebook session and MCP process private; do not expose the server directly to the public Internet.

## ChatGPT alert and Drive handoff

The existing `scripts/hardware-watch.ts` runner keeps every timestamped JSON and Markdown report locally under `.local/hardware-watch`. When a run completes without query errors, it also copies both reports into the authorized, synced Google Drive folder `Hardware Watch Alert Inbox`. The runner discovers the existing Google Drive mount without reading or logging credentials; `HARDWARE_WATCH_DRIVE_FOLDER_PATH` can be set to an authorized synced folder when automatic discovery is unavailable. Runs with query errors are retained locally and are not uploaded.

The ChatGPT heartbeat is the alert handoff: it runs the bounded, read-only watcher and reports the new-listing, error, and upload status. It does not update the Hardware Deal Watch spreadsheet, create Marketplace monitors, contact sellers, or purchase anything. Current status: **active and tested** — a report was uploaded and verified in the target private Drive folder; local copies remain the source for recovery. To pause or disable the recurring run, pause or delete the existing Codex automation named `Hardware Deal Watch — Churchville Marketplace`; the local runner itself can still be run manually.

## Consolidation and fork rationale

The repository's `FORK_NOTES.md`, `HANDOVER.md`, and the 2026-09-15 consolidation plan/spec remain the source of truth for the MCP architecture. The public fork comparison reached the same boundary:

- Retain the consolidated-line ideas already in this build: direct GraphQL transport, structured Relay parsing, degraded-result hydration, bounded cursor traversal, listing-ID deduplication, explicit `needs_hydration`, and read-only image/detail access.
- Adopt the useful location idea described by `maxaiassistant77/facebook-marketplace-mcp`: prefer exact, usable location data rather than treating a provider-side radius as proof. In this watcher that means post-result distance validation, a conservative city/state fallback, raw-only handling for unknown locations, and candidate ranking after validation.
- Do not import `jlsookiki/secondhand-mcp`'s multi-marketplace/eBay/Depop/Poshmark surface or duplicate the eBay watch. Its documented Facebook result model is city-level, which reinforces the need to label distance estimates as approximate.
- Do not replace this MCP with `jdcodes1/facebook-marketplace-mcp`; its direct GraphQL/session-cookie and bounded-rate concepts are already represented here, while this build additionally preserves the consolidated parser, diagnostics, pagination, monitor compatibility, local reports, and Drive handoff.

This keeps the improvement narrow: the provider performs discovery, while the local watcher owns the documented Churchville radius and Mac Studio/Proxmox ranking policy. The fallback city map is intentionally incomplete; an unfamiliar or city-only location remains `distance unverified` rather than being guessed into an alert.

## Local dashboard

The dependency-free dashboard reads only existing JSON reports from `.local/hardware-watch`; it does not call Facebook or the MCP and does not write reports, state, Drive, Sheets, or tracker data.

Run it from the repository with:

```sh
npm run dashboard
```

Then open `http://127.0.0.1:4173/`. Set `HARDWARE_WATCH_OUTPUT_DIR` to view another local report directory, or `HARDWARE_WATCH_DASHBOARD_PORT` to use another local port. Stop it with `Ctrl-C` (or terminate the process serving that localhost port). The dashboard marks missing, malformed, stale, error, and empty report states; only listings with explicit verified in-radius status appear in the deal view. Raw, unverified, out-of-radius, legacy, and excluded listings remain in Diagnostics.

The dashboard's **Next run configuration** panel is local-only and does not include a Run now action. It edits query text/order, per-query result limits, page counts, and optional price bounds (including an explicit `$0` maximum), while showing duplicate/validation errors, the Churchville center/radius, target presets, planned request count, and an approximate wait for the configured 3-requests-per-minute limiter. Saving writes only `.local/hardware-watch/pending-configuration.json`; it does not affect the active watcher or schedule. Applying requires the explicit confirmation in the panel, writes a local active configuration plus a recoverable backup, and is consumed only by the next normal watcher invocation, which reads the active configuration at startup. A confirmation-gated **Discard pending configuration** action deletes only that pending draft and leaves the active configuration, backups, reports, reviews, and schedule unchanged; after discard the panel explicitly shows that no pending configuration is saved. The panel also offers a confirmation-gated revert using the backup and leaves that backup in place for recovery. The existing twice-daily automation remains unchanged unless the explicit apply flow is used; credentials, Drive, Sheets, tracker data, and raw reports are outside this flow.

The dashboard also provides a local shortlist/review workflow. Target and review-status filters, plus price, distance, newest-run, best-rank, and review-status sorting, apply only to the current saved report view. One-click triage filters cover new listings, price drops, newly available listings, Interested, Verify, and Unreviewed; the active-filter summary and reset control make combined filters explicit. The compact top summary keeps run status, counts, and active filters visible. Configuration, New since last run, Best matches, Diagnostics, and bulk-review history are grouped into native accessible collapsible sections; open/closed preferences are stored only in browser localStorage and can be restored to defaults without changing filters, selections, reviews, reports, or configuration. Listing cards stay compact by default and expose report evidence, target fit, missing/unverified checks, price/build caveats, and manual review data through an accessible disclosure. **Copy checklist** copies only a concise checklist derived from saved listing facts and existing `nextChecks`; it does not contact sellers or open external flows. When a saved report already contains a valid `http`/`https` `image_url`, the card may show it as a small fixed-size lazy thumbnail with title-derived alt text, `no-referrer`, and a visible fallback when the URL is absent or the image fails. The browser therefore requests those exact saved image URLs; the dashboard does not scrape pages, resolve URLs, proxy images, or fetch listing details. **Hide thumbnails** stores a browser-local preference only. Each listing can be marked **Unreviewed**, **Interested**, **Verify**, **Passed**, or **Acquired**, with notes and manual verification details. Explicitly selected listings can receive a bulk status change after confirmation. Those actions are audited in the separate bounded `.local/hardware-watch/bulk-review-history.json` file; the dashboard keeps recent entries across restarts, requires explicit confirmation to undo, and refuses an undo if any selected review changed after the bulk action. Successful undo restores the prior status, notes, manual details, and reviewed timestamp exactly. Bulk changes preserve existing notes and manual details and never overwrite report facts. Malformed review/history entries are ignored with a diagnostic, and review IDs no longer present in the latest reports are retained but reported as stale metadata. Saving a review is a local dashboard write only; it cannot start the watcher, call Facebook/MCP, contact sellers, or alter the schedule.

The collapsible **Run history & health** section reads only saved `report-*.json` files. It shows the recorded run timestamp, health status, candidate/diagnostic counts when a listing snapshot is present, new/updated counts when recorded, run and per-query errors when attributed, and the exact prior report filename referenced by `previousRunAt`. Missing snapshots, missing comparison files, malformed files, stale runs, and unavailable per-query fields are labeled explicitly rather than inferred from the current configuration or array order. The read-only comparison selector changes only the displayed historical summary; it does not change the active report, review state, pending configuration, or watcher schedule. Historical run configuration is shown only where the report itself records it; the dashboard does not substitute the current configuration.

### Free Finds mode

The Free Finds panel includes a compact saved-report health summary with the recorded status, last attempt, last success, 36-hour stale threshold, and malformed-report count. These values come only from saved reports; unavailable fields remain labeled unavailable, and stale or failed results are not presented as current.

It also shows a **Needs attention** count summary for new, reappeared, changed, and unreviewed saved listings, stale result rows, malformed reports, and listings with unavailable distance or price. These are review signals only; they do not confirm that an item is free, available, profitable, or verified.

The saved Free Finds view also exposes a price signal filter and sort: **Listed at $0**, **Listed as free**, **Other price**, or **Price unavailable**. These are listing signals only; every result remains unconfirmed until manual review, so `$0` is never presented as proof that an item is genuinely free.

Free Finds is an isolated, configuration/review-only mode alongside Hardware Watch. Its local files are `.local/hardware-watch/free-finds-configuration.json`, `.local/hardware-watch/free-finds-reviews.json`, and future `free-finds-report-*.json` files; it never reads or writes the Hardware Watch active/pending configuration, reviews, schedule, raw reports, Drive, Sheets, or tracker data. The local organizer supports searchable saved queries with add/remove/reorder, duplicate validation, per-query result/page limits, optional radius overrides, the saved default center/radius, and a fixed per-query/global `maxPrice: 0` because the current mode is specifically for free-item leads. It shows saved results with review-status, distance, newest-run, query filters/sorting, and bounded cross-run presence badges for **New to retained history**, **Seen in prior saved runs**, and **Reappeared after an absence**. Stable listing IDs and the retained reports make this history auditable without deleting prior reports; the exact prior-run comparison still drives new/updated field changes. Free-item review statuses are **Unreviewed**, **Interested**, **Pickup planned**, **Collected**, **Passed**, and **Unavailable/claimed**; pickup notes, optional planned pickup date/time, and user notes are stored separately from report facts. Legacy `Unavailable` review values are normalized to `Unavailable/claimed`. The panel also provides a local **run readiness preview**: enabled-query counts, result slots, planned page requests, limiter wait range, global center/radius behavior, and validation warnings. It is a preview only and has no execution action.

The current MCP technically supports a bounded future Free Finds search: the validated search tool accepts latitude/longitude, radius up to 1,000 km, `limit` up to the MCP's configured maximum, and `max_pages` up to 10; the Facebook client applies the price bound and unknown prices fail closed. The current client rate limiter defaults to 3 requests per minute with jitter (roughly 0.5–2 seconds between requests and 1–3 seconds after a minute-window wait). These are technical interface limits, not proof that Facebook will return genuine free items: `$0` can be a placeholder, trade, service, or unrelated result and still requires review. The organizer never infers availability from a listing's age, title, or price; availability remains a manual review question because listings can change or be claimed.

The Free Finds saved-results view defaults to **New to retained history + Unreviewed** for quick triage. A separate **New, reappeared, or changed + Unreviewed** view brings back stable IDs that reappeared after an absence and listings whose bounded fields changed, while keeping reviewed items out of the fast-review queue. These views are triage shortcuts only: a new or changed result is not confirmed free. Saving a review writes only `free-finds-reviews.json`, so the status and notes survive dashboard refreshes and later saved reports. Reviewed items remain available through **All saved listings** and review-status filters. Newness, reappearance, field changes, and `$0`/“free” price signals are never treated as confirmation of free status, availability, contact, or collection.

Free Finds also stores a separate personal **pickup tracking** state in `free-finds-reviews.json`: **None**, **Interested**, **Contacted**, **Claimed/gone**, **Collected**, or **No longer interested**. This is the user's own follow-up record, separate from review status, price signal, report health, and Facebook availability. It does not contact sellers, prove that a listing is still available or free, or prove that collection occurred; pickup notes and planned pickup time remain personal notes.

Free Finds keeps listing location/distance separate from personal pickup notes and pickup status. When a saved listing contains a finite `distanceKm`, the dashboard displays it to one decimal place and the distance filter can show listings with distance available or unavailable. A saved non-placeholder `distanceLabel` may be shown when no numeric distance exists; otherwise the card explicitly says **Distance unavailable**. The dashboard never calculates distance from location text or invents a location, and pickup tracking does not change the listing's location or availability.

The saved-results view groups the current filtered listings by their saved query and shows per-query totals plus new, unreviewed, repeated, and reappeared counts when those fields are present. A dedicated **saved query** filter now narrows the review queue to one exact recorded query, while retaining an explicit **(query unavailable)** option for records without query provenance. The summary is explicitly a count of saved listings, not confirmed-free items; it does not replace the default **New to retained history + Unreviewed** triage view, **All saved listings**, or the existing review, price, distance, and history filters. Missing query values are labeled **(query unavailable)** rather than assigned to a guessed query. The Free Finds search text, saved-query, triage, review-status, price-signal, distance, and sort selections are remembered in browser `localStorage` only so a refresh returns to the same review queue; **Reset saved Free Finds view** clears that browser-local preference and restores the default new/unreviewed queue.

Free Finds also supports deliberate bulk review of the currently visible filtered listings. Each visible card can be selected, the toolbar shows the affected count, and applying a reviewed status requires explicit confirmation. The isolated bulk write updates only review status in `free-finds-reviews.json`; it preserves pickup tracking, notes, price signals, report facts, availability, distance, photos, and health. Selected items leave the default unreviewed triage view but remain in **All saved listings** and review-status filters. Bulk review is a personal organizer action, not seller contact, availability confirmation, or proof that an item is free.

Free Finds cards also make photo state explicit using only an existing saved `image_url`/`imageUrl`: valid HTTP(S) values appear as compact lazy thumbnails, failed image loads show **Image unavailable**, and missing or invalid values show **No image available in saved report**. Missing photos are neutral evidence; they do not imply that a listing is suspicious, unavailable, unfree, or lower priority. The dashboard does not scrape, resolve, proxy, or fetch listing details to obtain an image.

Free Finds health is isolated to saved `free-finds-report-*.json` history. A successful report with no errors is **healthy** when its last success is no more than 36 hours old; an empty successful report is still a healthy search with zero results. A latest failed/partial attempt is **failed**, with its last-attempt time and first failure reason, while only the prior successful results are displayed and marked stale. If no successful report exists, the state is **no success** and listings are not presented as current. If the most recent successful report is older than 36 hours, the state is **stale**. The dashboard shows last attempt, last success, the fixed 36-hour rule, and failure reason when available; it also surfaces the names of malformed saved reports while retaining the last readable results. Malformed files do not become a current run and are never silently treated as successful. It never treats an old saved result as current after a failed or missed run.

No hourly Free Finds scheduler is enabled by default. The isolated runner is bounded by configuration validation, a lock file, per-search request timeouts, a whole-run timeout, graceful client/transport shutdown, and partial-failure receipts. It writes only `free-finds-report-*.json` files and never uploads them or changes Hardware Watch state. The dashboard exposes a confirmation-gated scheduler configuration under `free-finds-scheduler.json`; enabling requires typing `ENABLE_FREE_FINDS_HOURLY`, shows the calculated next-run time, and disabling requires `DISABLE_FREE_FINDS_HOURLY`. This stores scheduler intent only; there is still no Free Finds Run Now button and no live scheduler process is started by the dashboard. The existing twice-daily Hardware Watch schedule is unchanged.

The bounded runner entry point is `npm exec -- tsx scripts/free-finds-runner.ts`. The separate foreground service is `npm run free-finds-scheduler`; it reads only the Free Finds scheduler/configuration files and logs outcomes to `free-finds-scheduler.log`. It exits its scheduling loop with `Ctrl-C` (SIGINT) or SIGTERM; it is not installed as a login item, daemon, startup task, or system service. `npm run free-finds-scheduler -- --status` reports persisted scheduler state without starting a process and checks the recorded process ID so a stale health file is not treated as proof that the service is still running. After each completed run, retention keeps the newest 48 readable `free-finds-report-*.json` files; malformed reports are retained for diagnosis, and the scheduler log rotates at 512 KiB with one `.1` backup. The service starts disabled unless the persisted state is valid and explicitly enabled, recovers at most one missed tick after restart, never overlaps runs, and does not replay every missed interval. It does not provide a dashboard Run Now action. The existing twice-daily Hardware Watch schedule is unchanged.

Before any owner enables a real hourly process, the owner must review applicable Facebook/MCP access constraints, account and operational rate limits, timeout/overlap behavior, retention and comparison policy, and whether any alert or Drive handoff is authorized. Code support for an hourly cadence is not approval to operate it. A future deployment also needs an explicitly authorized private process that invokes the bounded runner and a documented report/alert policy.

### Prioritized Free Finds backlog

1. Improve fast review: keep new/updated items prominent, preserve the price-signal distinction, and add compact manual confirmation fields without inferring that `$0` means free.
2. Strengthen repeated-result handling: retain stable-ID history across runs, make disappearance/reappearance explicit, and keep comparison behavior bounded and auditable.
3. Improve health and recovery: surface stale, partial, malformed, timeout, and restart-recovery states consistently in the local status view and logs.
4. Add broader non-hardware query presets, such as furniture, building materials, appliances, and household goods, while keeping each category's configuration and review language explicit.
5. Add uncertain resale/deal evaluation as a separate, review-only mode with visible assumptions, unknowns, fees, condition, and no automatic valuation claims.
6. Add compact photo-based review using only saved authorized image URLs; never scrape listing pages, contact sellers, or infer condition from missing photos.
7. Harden reliability and privacy: validate retention/recovery boundaries, minimize local sensitive data, document rate-limit behavior, and keep all storage/report/log paths isolated from Hardware Watch.

Saved Free Finds snapshots retain their raw listing arrays. If a snapshot repeats a stable listing ID, the dashboard collapses that ID only for saved-result comparison, reports the duplicate-entry count in run history, and leaves the raw report unchanged.
