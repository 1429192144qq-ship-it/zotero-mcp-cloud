# Architecture

Technical architecture of the zotero-mcp server.

## Overview

```
┌─────────────────────────────────────────────────┐
│  MCP Client (Claude Desktop / Code / other)     │
└─────────────────┬───────────────────────────────┘
                  │ stdio, or authenticated HTTP (auth.ts + http.ts)
┌─────────────────▼───────────────────────────────┐
│  server.ts — createZoteroServer()               │
│  ┌─────────────────────────────────────────┐    │
│  │  9 Tool Handlers (Zod-validated params) │    │
│  └──────────────────┬──────────────────────┘    │
│                     │                           │
│  ┌──────────────────▼──────────────────────┐    │
│  │  utils.ts — Markdown formatters,        │    │
│  │             escapeHtml                  │    │
│  └─────────────────────────────────────────┘    │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│  zotero-api.ts — ZoteroClient                   │
│  ┌─────────────────────────────────────────┐    │
│  │  rateLimitedFetch() — 1 req/sec         │    │
│  │  Backoff / Retry-After handling         │    │
│  └──────────────────┬──────────────────────┘    │
│                     │                           │
│  ┌──────────────────▼──────────────────────┐    │
│  │  Local file access (~/Zotero/storage)   │    │
│  └─────────────────────────────────────────┘    │
└─────────────────┬───────────────────────────────┘
                  │ HTTP (fetch)
┌─────────────────▼───────────────────────────────┐
│  Zotero API v3                                  │
│  - Web API: api.zotero.org                      │
│  - Local API: localhost:23119 (Desktop)         │
└─────────────────────────────────────────────────┘
```

## Modules

### `index.ts` — Entry point

- Environment variable validation
- ZoteroClient initialization
- Transport selection (stdio vs http); http refuses to start without
  `MCP_AUTH_TOKEN_HASHES`

### `server.ts` — Tool registry

- `createZoteroServer(zotero, { allowWrite, dataDir })` builds one McpServer
- 6 read tools always; 3 write tools only when `allowWrite` is true
- `zoteroKey` schema validates 8-character Zotero keys
- `dataDir` undefined disables local filesystem lookups

### `auth.ts` — Bearer-token authentication

- Parses `MCP_AUTH_TOKEN_HASHES` (`label:sha256hex[:ro|rw]`)
- Hashes the presented token and compares it in constant time with every entry
- Rejects short (<32 chars), oversized, repeated or non-Bearer credentials

### `http.ts` — Authenticated Streamable HTTP

- Authenticates every `/mcp` request before reading its body or touching MCP
- One McpServer per session, bound to the token label that created it
- Session cap, idle eviction, body size limit, optional Host allowlist
- `/healthz` is unauthenticated and returns only `ok`

### `zotero-api.ts` — ZoteroClient

HTTP client for Zotero API v3. Responsibilities:
- Rate-limited fetch (1 request/second minimum interval)
- Automatic Backoff/Retry-After header handling
- All CRUD operations (collections, items, notes)
- Attachment download (local file or API)
- Full-text content retrieval (local cache or API)
- Configurable for Web API, Local API, user/group libraries

### `utils.ts` — Utilities

Shared helper functions:
- `escapeHtml()` — sanitize user input for HTML output
- `formatCreator()` — format Zotero creator for display
- `htmlToMarkdown()` — convert Zotero note HTML to Markdown
- `truncate()` — text truncation with ellipsis
- `formatItemMarkdown()` — full item detail in Markdown
- `formatItemSummary()` — compact item summary for search results

## Transport Modes

### stdio (default)

Standard MCP transport. JSON-RPC messages over stdin/stdout.
Used by Claude Code and Claude Desktop.

### HTTP (authenticated Streamable HTTP)

Remote/Docker transport (`--transport http`). Clients send
`Authorization: Bearer <token>` on every request.

```
Client                                  Server (PORT, default 3000)
  │── POST /mcp  (no/invalid token) ──────►│  401 + WWW-Authenticate
  │── POST /mcp  initialize + token ──────►│  authenticate → new session
  │◄── 200 + Mcp-Session-Id ──────────────│  (server per session)
  │── POST/GET/DELETE /mcp + session ─────►│  same token required
```

Write tools are registered only if `ZOTERO_MCP_ENABLE_WRITE=true` and the
token entry is `rw`. The former unauthenticated SSE transport was removed.

## Data Flow: Local-First Strategy

For `get_item_fulltext` and `read_attachment`, the server uses a local-first
approach when Zotero Desktop storage is available:

```
Request
  │
  ├─► Check ZOTERO_DATA_DIR/storage/{key}/
  │   ├─ Found → Read local file (fast, no API call)
  │   └─ Not found ─┐
  │                  │
  └──────────────────┴─► Fetch from Zotero API (fallback)
```

`ZOTERO_DATA_DIR` defaults to `~/Zotero` for stdio. Over HTTP, local
lookups are disabled unless `ZOTERO_DATA_DIR` is set explicitly.
The full-text cache is read from
`.zotero-ft-cache` files inside each item's storage directory.

## Configuration Matrix

| Mode | API Key | Library ID | Base URL |
|------|---------|------------|----------|
| Web API (user) | Required | Required | `api.zotero.org` |
| Web API (group) | Required | Required | `api.zotero.org` (uses `/groups/` prefix) |
| Local API | Not needed | Optional (default: `0`) | `127.0.0.1:23119/api` |

## Tool Output Formats

| Tool | Output Format |
|------|--------------|
| `list_collections` | JSON |
| `create_collection` | JSON |
| `create_note` | JSON |
| `add_note_to_collection` | JSON |
| `get_item` | LLM-optimized Markdown (full detail) |
| `search_items` | LLM-optimized Markdown (compact summaries) |
| `get_item_attachments` | JSON (attachment list) |
| `get_item_fulltext` | Plain text (full-text content) |
| `read_attachment` | Text (local path) or base64 (API download) |

## Design Decisions

1. **No HTTP client library** — Node 18+ built-in `fetch` keeps dependencies
   minimal and avoids bloat.

2. **Rate limiting in client** — Centralized `rateLimitedFetch()` ensures
   all API calls respect Zotero's 1 req/sec limit regardless of tool usage.

3. **LLM-optimized Markdown** — `get_item` and `search_items` return structured
   Markdown instead of JSON because LLMs process formatted text more efficiently.
   Write-oriented tools keep JSON for structured responses.

4. **Local-first file access** — When Zotero Desktop storage is available,
   reading files locally avoids API calls and base64 encoding overhead.

5. **Authentication in-process** — The SDK's StreamableHTTPServerTransport is
   wrapped by our own auth check instead of a stdio-to-HTTP gateway, so no
   request reaches the MCP layer without a valid token.

6. **Static bearer tokens, stored as hashes** — Codex and Claude both support
   a fixed `Authorization: Bearer` header. The server keeps only SHA-256
   hashes, so a leaked server configuration does not reveal usable tokens.

7. **Read-only by default remotely** — Remote clients get the six read tools
   unless writes are explicitly enabled for the server and the token.
