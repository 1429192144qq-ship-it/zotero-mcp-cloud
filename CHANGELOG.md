# Changelog

## [Unreleased]

### Security — authenticated remote access

- **Breaking:** removed the unauthenticated SSE transport and the
  `supergateway` wrapper used by the Docker image. Neither checked inbound
  credentials (`supergateway`'s `--header`/`--oauth2Bearer` only set
  *response* headers).
- New `--transport http`: native Streamable HTTP at `/mcp` with server-side
  bearer-token authentication. Unauthenticated requests get `401` before any
  MCP handling. The server refuses to start without `MCP_AUTH_TOKEN_HASHES`.
- Tokens are stored server-side only as SHA-256 hashes (`label:hash[:ro|rw]`),
  compared in constant time; tokens shorter than 32 characters, tokens in
  query strings, and repeated `Authorization` headers are rejected.
- Sessions are bound to the token that created them; other tokens get `404`.
  Session cap (50), idle eviction (30 min) and 1 MiB body limit.
- Read-only by default over HTTP: write tools are registered only when
  `ZOTERO_MCP_ENABLE_WRITE=true` and the token is `rw`. stdio keeps write
  tools unless `ZOTERO_MCP_ENABLE_WRITE=false`.
- HTTP mode disables local filesystem lookups unless `ZOTERO_DATA_DIR` is set.
- Zotero key parameters are validated as 8-character keys (A-Z, 0-9).
- `npm run token:generate -- <label> [ro|rw]` prints a client token and the
  matching server entry.
- Docker image runs as the non-root `node` user, has a `/healthz`
  `HEALTHCHECK`, honours `PORT`, and installs only lockfile dependencies.
- Tool logic moved to `src/server.ts` (`createZoteroServer`); read tools keep
  their names, parameters and output formats.
- Repeated `Authorization` headers are detected from `req.rawHeaders` (Node
  keeps only the first value in `req.headers`) and rejected even when the
  first token is valid.
- CI `container` job builds the real Dockerfile and runs
  `scripts/container-check.sh` with throwaway credentials: refuses to start
  without auth config, HEALTHCHECK healthy, `401` for unauthenticated and
  duplicate-header requests, write tools refused in read-only mode.
- README client-compatibility table: claude.ai web connector header support
  is unverified; no authless fallback.
- Tests: 84 → 163 (auth, tool registry/compatibility, HTTP end-to-end,
  raw-socket duplicate-header cases).

### Earlier unreleased changes

### Added — Tools

- `get_item` MCP tool — retrieve single item with full metadata (9 tools total)
- `get_item_attachments` — list attachments with local path detection
- `get_item_fulltext` — full-text content (local cache → API fallback)
- `read_attachment` — read file (local path → API base64 download)
- `tag` parameter for `search_items` — filter by tag with boolean syntax
  (`tag1 || tag2`, `-excludeTag`)
- `forceRemote` parameter for `get_item_attachments`, `get_item_fulltext`,
  and `read_attachment` — bypasses local storage and fetches from the API

### Added — Features

- Zotero Local API support (`ZOTERO_LOCAL=true`) — connect to Zotero Desktop
  at `localhost:23119` without API key
- Group library support (`ZOTERO_LIBRARY_TYPE=group`) — access group libraries
  in addition to user libraries
- LLM-optimized Markdown output for `get_item` and `search_items` tools —
  structured headings, formatted creators, backtick-wrapped keys/tags
- SSE transport support (`--transport sse --port 3000`) — HTTP-based transport
  for Docker and remote access
- `ZOTERO_DATA_DIR` env variable for local Zotero storage (default: `~/Zotero`)

### Added — Infrastructure

- `Dockerfile` with multi-stage build for containerized deployment
- `.dockerignore` for efficient Docker builds
- Markdown helper functions in `utils.ts`: `formatCreator`, `htmlToMarkdown`,
  `truncate`, `formatItemMarkdown`, `formatItemSummary`
- 3 new `ZoteroClient` methods: `getItemChildren`, `getFullText`,
  `downloadAttachment`
- Type definitions: `ZoteroAttachmentData`, `ZoteroFullText`, `AttachmentInfo`
- `src/utils.ts` — extracted `escapeHtml` and added Markdown formatting helpers
- Unit test suite with Vitest (84 tests)
  - Utility function tests: escapeHtml, formatCreator, htmlToMarkdown,
    truncate, formatItemMarkdown, formatItemSummary (39 tests)
  - `ZoteroClient` tests including local API, group library, tag search (45 tests)
- `npm test` script
- `CONTRIB.md` — contribution guidelines
- `docs/architecture.md` — technical architecture document

### Changed

- `search_items` output changed from JSON to LLM-optimized Markdown format
- `ZoteroConfig` extended with `libraryType` and `isLocal` options
- `downloadAttachment()` now uses centralized `headers()` method
- `escapeHtml` moved from `index.ts` to `src/utils.ts`
- `tsconfig.json` excludes `src/__tests__/` from build output

## [1.0.0] - 2026-01-29

### Added

- Initial release
- 5 MCP tools: `list_collections`, `create_collection`, `create_note`,
  `add_note_to_collection`, `search_items`
- Zotero Web API v3 client with rate limiting (1 req/sec)
- Automatic Backoff / Retry-After handling
- Pagination support for list and search operations
- Zotero-compatible HTML note template
- HTML escaping for note titles
- Descriptive error messages based on HTTP status codes
