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
