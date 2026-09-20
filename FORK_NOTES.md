# Consolidated Fork Notes

This fork is based on the stronger consolidated `rikhoffbauer/facebook-marketplace-mcp` line rather than the original upstream master.

## Goals

- Keep all Facebook-facing operations read-only.
- Preserve direct GraphQL operation at runtime rather than browser automation for every search.
- Improve resilience when Facebook changes response shapes or persisted-query identifiers.
- Make saved monitors more useful for low-frequency deal watching.
- Allow a vision-capable MCP client to inspect selected listing photos without receiving arbitrary remote URLs.
- Harden local handling of browser profiles, session cookies, monitor state, and diagnostics.

## Changes in this fork

- Added `facebook_marketplace_get_listing_images` with HTTPS Facebook-CDN validation, MIME checking, redirect refusal, a 10 MB per-image limit, and a maximum of 10 requested photos.
- Extended saved monitors with sort, delivery-method, listed-within, result-limit, and page-depth settings.
- Hardened Chrome profile selection against path traversal.
- Replaced shell-based Chrome cookie-database copying with private temporary-file operations.
- Rejects malformed cookie names and cookie values containing control characters or semicolons before constructing HTTP headers.
- Stores monitor state in a private directory/file and refuses symbolic-link monitor files.
- Added regression tests and CI coverage.
- Added a scheduler-agnostic watcher design in `docs/marketplace-watch.md`.

## Deliberately excluded

This fork does **not** add seller messaging, auto-contact, listing creation, or other Facebook write operations. A human remains responsible for contacting a seller.

Vehicle-specific valuation logic, KBB integrations, and domain-specific seller-outreach features found in some forks are also intentionally excluded.

## Provenance

The fork audit reviewed the direct fork network and upstream pull requests for useful ideas. Where another fork contained a useful concept, this branch implements the capability within the consolidated codebase rather than importing an entire unrelated feature set.

No new software license is asserted here. The upstream/fork network did not include a LICENSE file at the time of this consolidation; review repository provenance and GitHub's terms before redistribution outside the fork network.
