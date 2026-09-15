# Facebook Marketplace Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate PR #4 with the durable compatibility improvements from PR #5 and bounded multi-page search.

**Architecture:** Keep PR #4's direct GraphQL client and structured Relay parser. Add explicit degraded-result hydration, flexible session sourcing, separate request budgets, and cursor traversal without replacing the MCP/service boundaries.

**Tech Stack:** TypeScript ESM, Node.js >= 22, MCP SDK, Zod, Playwright for interactive login/query discovery.

**Spec:** `docs/superpowers/specs/2026-09-15-facebook-marketplace-consolidation-design.md`

## Global Constraints
- Keep runtime search direct-GraphQL; no browser automation for normal searches.
- Never silently turn schema/auth failures into zero listings.
- Preserve PR #4's structured requested-listing Relay parser.
- Bound pagination to at most 10 pages through the MCP contract.
- Never persist or emit authentication secrets in diagnostics.

---

### Task 1: Recover degraded search feed units
- [x] Add failing regression for `story_key` / `top_level_post_id` feed nodes.
- [x] Emit typed hydration stubs while preserving cursor metadata.
- [x] Hydrate only retained results and expose failed hydration explicitly.

### Task 2: Preserve both session acquisition paths
- [x] Add Chrome display-name resolution regression.
- [x] Prefer valid saved sessions and fall back to Chrome only when no snapshot is selected/present.
- [x] Keep explicit session-file failures fail-closed.

### Task 3: Add bounded cursor traversal
- [x] Add failing multi-page/deduplication regression.
- [x] Implement `maxPages` traversal with total-listing bound and cursor stopping conditions.
- [x] Publish `max_pages` in the MCP input contract.

### Task 4: Improve monitoring coverage
- [x] Add monitor-default regression.
- [x] Save monitors with a three-page / 72-listing scan bound.

### Task 5: Verify and document
- [x] Update README, root agent guidance, and handover notes.
- [ ] Run the complete test suite, TypeScript build, diff check, and repository-status verification.
- [ ] Commit and package the complete repository and git history.
