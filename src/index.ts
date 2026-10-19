#!/usr/bin/env node

/**
 * Zotero MCP Server
 *
 * An MCP (Model Context Protocol) server that exposes Zotero library
 * management tools via the Zotero Web API v3.
 *
 * Tools (see server.ts):
 *   Read  — list_collections, get_item, search_items, get_item_attachments,
 *           get_item_fulltext, read_attachment
 *   Write — create_collection, create_note, add_note_to_collection
 *
 * Transports:
 *   stdio (default)  — local process; write tools enabled unless
 *                      ZOTERO_MCP_ENABLE_WRITE=false
 *   http             — authenticated Streamable HTTP for remote use;
 *                      read-only unless ZOTERO_MCP_ENABLE_WRITE=true
 *
 * Environment variables (required unless ZOTERO_LOCAL=true):
 *   ZOTERO_API_KEY      — Zotero API key
 *   ZOTERO_LIBRARY_ID   — Zotero user/group library ID
 *
 * Environment variables (required for --transport http):
 *   MCP_AUTH_TOKEN_HASHES — label:sha256hex[:ro|rw] entries (see auth.ts)
 *
 * Environment variables (optional):
 *   ZOTERO_DATA_DIR         — Local Zotero data directory (stdio default: ~/Zotero;
 *                             http: local file access disabled unless set)
 *   ZOTERO_LOCAL            — Connect to Zotero Desktop local API (default: false)
 *   ZOTERO_LIBRARY_TYPE     — "user" (default) or "group"
 *   ZOTERO_MCP_ENABLE_WRITE — "true"/"false" override for write tools
 *   MCP_ALLOWED_HOSTS       — http: comma-separated Host header allowlist
 *   PORT                    — http: listen port (default 3000; --port wins)
 *
 * @see https://www.zotero.org/support/dev/web_api/v3/basics
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { ZoteroClient } from "./zotero-api.js";
import { createZoteroServer } from "./server.js";
import { parseTokenHashes } from "./auth.js";
import { createHttpServer } from "./http.js";

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(): { transport: "stdio" | "http"; port: number } {
  let transport: "stdio" | "http" = "stdio";
  let port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--transport" && process.argv[i + 1]) {
      const v = process.argv[i + 1];
      if (v === "stdio" || v === "http") {
        transport = v;
      } else if (v === "sse") {
        console.error(
          "Error: the SSE transport was removed because it had no authentication.\n" +
            "  Use --transport http (authenticated Streamable HTTP) instead.",
        );
        process.exit(1);
      } else {
        console.error(`Error: unknown transport "${v}" (expected stdio or http).`);
        process.exit(1);
      }
      i++;
    }
    if (process.argv[i] === "--port" && process.argv[i + 1]) {
      port = parseInt(process.argv[i + 1], 10);
      i++;
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Error: invalid port.");
    process.exit(1);
  }
  return { transport, port };
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const args = parseArgs();

const ZOTERO_LOCAL = process.env.ZOTERO_LOCAL === "true";
const ZOTERO_API_KEY = process.env.ZOTERO_API_KEY;
const ZOTERO_LIBRARY_ID = process.env.ZOTERO_LIBRARY_ID;
const ZOTERO_LIBRARY_TYPE =
  (process.env.ZOTERO_LIBRARY_TYPE ?? "user") as "user" | "group";

if (!ZOTERO_LOCAL && (!ZOTERO_API_KEY || !ZOTERO_LIBRARY_ID)) {
  console.error(
    "Error: ZOTERO_API_KEY and ZOTERO_LIBRARY_ID are required (unless ZOTERO_LOCAL=true).\n" +
      "  export ZOTERO_API_KEY=your_api_key\n" +
      "  export ZOTERO_LIBRARY_ID=your_library_id\n" +
      "  # OR for local Zotero Desktop API:\n" +
      "  export ZOTERO_LOCAL=true",
  );
  process.exit(1);
}

const enableWriteEnv = process.env.ZOTERO_MCP_ENABLE_WRITE;
if (enableWriteEnv !== undefined && enableWriteEnv !== "true" && enableWriteEnv !== "false") {
  console.error('Error: ZOTERO_MCP_ENABLE_WRITE must be "true" or "false".');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Initialise client
// ---------------------------------------------------------------------------

const zotero = new ZoteroClient({
  apiKey: ZOTERO_LOCAL ? "" : ZOTERO_API_KEY!,
  libraryId: ZOTERO_LOCAL ? (ZOTERO_LIBRARY_ID ?? "0") : ZOTERO_LIBRARY_ID!,
  libraryType: ZOTERO_LIBRARY_TYPE,
  isLocal: ZOTERO_LOCAL,
  baseUrl: ZOTERO_LOCAL ? "http://127.0.0.1:23119/api" : undefined,
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (args.transport === "stdio") {
    const server = createZoteroServer(zotero, {
      allowWrite: enableWriteEnv !== "false",
      dataDir: process.env.ZOTERO_DATA_DIR ?? join(homedir(), "Zotero"),
    });
    await server.connect(new StdioServerTransport());
    console.error("Zotero MCP server running on stdio");
    return;
  }

  let tokens;
  try {
    tokens = parseTokenHashes(process.env.MCP_AUTH_TOKEN_HASHES);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
  if (tokens.length === 0) {
    console.error(
      "Error: refusing to start the HTTP transport without authentication.\n" +
        "  Set MCP_AUTH_TOKEN_HASHES (generate entries with `npm run token:generate -- <label>`).",
    );
    process.exit(1);
  }

  const enableWrite = enableWriteEnv === "true";
  const dataDir = process.env.ZOTERO_DATA_DIR;
  const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");

  const httpServer = createHttpServer({
    tokens,
    enableWrite,
    allowedHosts,
    createMcpServer: ({ allowWrite }) =>
      createZoteroServer(zotero, { allowWrite, dataDir }),
  });

  httpServer.listen(args.port, () => {
    console.error(
      `Zotero MCP server running on authenticated HTTP at :${args.port}/mcp ` +
        `(clients=${tokens.length}, write=${enableWrite ? "enabled" : "disabled"})`,
    );
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
