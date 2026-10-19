/**
 * Authenticated Streamable HTTP transport.
 *
 * Every request to the MCP path must carry a valid bearer token (see auth.ts)
 * before it reaches the MCP SDK. Each session gets its own McpServer, bound to
 * the token that initialised it: another token cannot reuse the session, and
 * write tools exist only if writes are enabled server-wide AND the token is
 * "rw".
 *
 * Routes:
 *   GET  /healthz   → 200 "ok" (no authentication, no library data)
 *   POST /mcp       → JSON-RPC (initialize creates a session)
 *   GET  /mcp       → SSE stream for an existing session
 *   DELETE /mcp     → close an existing session
 */

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { authenticate, type TokenEntry } from "./auth.js";

export interface HttpServerOptions {
  /** Accepted tokens. Must be non-empty. */
  tokens: readonly TokenEntry[];
  /** Builds the MCP server for a new session. */
  createMcpServer: (ctx: { allowWrite: boolean; label: string }) => McpServer;
  /** Server-wide switch for write tools. Default: false. */
  enableWrite?: boolean;
  /** MCP endpoint path. Default: "/mcp". */
  path?: string;
  /** Maximum concurrent sessions. Default: 50. */
  maxSessions?: number;
  /** Idle time before a session is closed, in ms. Default: 30 minutes. */
  sessionIdleMs?: number;
  /** Maximum JSON request body size in bytes. Default: 1 MiB. */
  maxBodyBytes?: number;
  /** If set, reject requests whose Host header is not listed. */
  allowedHosts?: string[];
  /** Log sink (stderr by default; stdout is never used). */
  log?: (message: string) => void;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  label: string;
  lastSeen: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      throw new HttpError(413, -32600, "Request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, -32700, "Parse error");
  }
}

export function createHttpServer(options: HttpServerOptions): Server {
  if (options.tokens.length === 0) {
    throw new Error("HTTP transport requires at least one auth token");
  }

  const tokens = options.tokens;
  const enableWrite = options.enableWrite ?? false;
  const mcpPath = options.path ?? "/mcp";
  const maxSessions = options.maxSessions ?? 50;
  const sessionIdleMs = options.sessionIdleMs ?? 30 * 60 * 1000;
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const allowedHosts = options.allowedHosts?.length
    ? new Set(options.allowedHosts.map((h) => h.toLowerCase()))
    : undefined;
  const log = options.log ?? ((m: string) => console.error(m));

  const sessions = new Map<string, Session>();

  async function closeSession(id: string): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  }

  function evictIdle(now: number): void {
    for (const [id, session] of sessions) {
      if (now - session.lastSeen > sessionIdleMs) void closeSession(id);
    }
  }

  async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    client: TokenEntry,
  ): Promise<void> {
    const sessionHeader = req.headers["mcp-session-id"];
    const body = req.method === "POST"
      ? await readJsonBody(req, maxBodyBytes)
      : undefined;

    if (sessionHeader !== undefined) {
      const session =
        typeof sessionHeader === "string" ? sessions.get(sessionHeader) : undefined;
      // A session belongs to the token that created it. Answer 404 either way
      // so another token cannot probe which session IDs exist.
      if (!session || session.label !== client.label) {
        throw new HttpError(404, -32001, "Session not found");
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      throw new HttpError(400, -32000, "Bad Request: No valid session ID provided");
    }

    evictIdle(Date.now());
    if (sessions.size >= maxSessions) {
      throw new HttpError(503, -32000, "Too many active sessions");
    }

    const allowWrite = enableWrite && client.canWrite;
    const server = options.createMcpServer({ allowWrite, label: client.label });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, {
          transport,
          server,
          label: client.label,
          lastSeen: Date.now(),
        });
        log(`[session] opened client=${client.label} write=${allowWrite}`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      // Health checks come from the platform with its own Host header, so
      // they are answered before the Host allowlist. No library data here.
      if (url.pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(req.method === "HEAD" ? undefined : "ok");
        return;
      }

      if (allowedHosts) {
        const host = (req.headers.host ?? "").toLowerCase();
        if (!allowedHosts.has(host)) {
          sendJsonRpcError(res, 403, -32000, "Forbidden host");
          return;
        }
      }

      if (url.pathname !== mcpPath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const client = authenticate(req.headers.authorization, tokens);
      if (!client) {
        log(`[auth] rejected ${req.method} ${url.pathname}`);
        sendJsonRpcError(res, 401, -32001, "Unauthorized", {
          "WWW-Authenticate": 'Bearer realm="zotero-mcp"',
        });
        return;
      }

      await handleMcp(req, res, client);
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJsonRpcError(res, error.status, error.rpcCode, error.message);
      } else {
        log(`[http] internal error: ${(error as Error).message}`);
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    });
  });

  const sweeper = setInterval(() => evictIdle(Date.now()), 60_000);
  sweeper.unref();
  httpServer.on("close", () => {
    clearInterval(sweeper);
    for (const id of [...sessions.keys()]) void closeSession(id);
  });

  return httpServer;
}
