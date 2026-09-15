# AGENTS.md

## Project
TypeScript ESM MCP server for read-only Facebook Marketplace access. Runtime transport is direct Facebook GraphQL; browser use is limited to interactive login/query discovery.

## Development
- Node.js >= 22. Use `npm ci`, `npm test`, and `npm run build`.
- Write regression tests before behavior changes. Keep parser failures distinct from legitimate zero-result searches.
- Prefer structured GraphQL/Relay JSON parsing. Do not add generated Facebook CSS selectors as a primary parser.
- Treat GraphQL `doc_id` values and response shapes as replaceable deployment details; update captures/tests when Facebook changes them.
- Never commit `.local/`, cookies, raw listing HTML, tokens, or captured private Facebook data.
- Keep search pagination bounded and deduplicate by listing ID.
- Use conventional commits.

## Verification
Run `npm test && npm run build && git diff --check` before committing behavior changes.
