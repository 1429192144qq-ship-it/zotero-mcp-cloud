/**
 * End-to-end tests for the authenticated Streamable HTTP transport (http.ts).
 * A real http.Server listens on an ephemeral localhost port; Zotero is a stub.
 * Tokens are test-only random values.
 */

import { randomBytes } from "node:crypto";
import { connect, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ZoteroClient } from "../zotero-api.js";
import { hashToken, parseTokenHashes } from "../auth.js";
import { createHttpServer, type HttpServerOptions } from "../http.js";
import { READ_TOOLS, WRITE_TOOLS, createZoteroServer } from "../server.js";
import { createStubZotero, type StubZotero } from "./helpers.js";

const roToken = randomBytes(32).toString("base64url");
const rwToken = randomBytes(32).toString("base64url");
const tokens = parseTokenHashes(
  `claude:${hashToken(roToken).toString("hex")}:ro,` +
    `codex:${hashToken(rwToken).toString("hex")}:rw`,
);

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "raw-test", version: "0" },
  },
};

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let httpServer: Server | undefined;
let clients: Client[] = [];
let logs: string[] = [];
let stub: StubZotero;

async function start(overrides: Partial<HttpServerOptions> = {}) {
  stub = createStubZotero();
  logs = [];
  const factory = vi.fn(({ allowWrite }: { allowWrite: boolean }) =>
    createZoteroServer(stub as unknown as ZoteroClient, { allowWrite }),
  );
  httpServer = createHttpServer({
    tokens,
    createMcpServer: factory,
    log: (m) => logs.push(m),
    ...overrides,
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, factory };
}

/**
 * Send a hand-written HTTP/1.1 request over a raw socket. fetch() merges
 * repeated headers into one, so duplicate-header cases need this.
 */
function rawPost(
  base: string,
  headerLines: string[],
  body: unknown,
): Promise<{ status: number; head: string }> {
  const { hostname, port } = new URL(base);
  const payload = JSON.stringify(body);
  const request = [
    "POST /mcp HTTP/1.1",
    `Host: ${hostname}:${port}`,
    "Content-Type: application/json",
    "Accept: application/json, text/event-stream",
    ...headerLines,
    `Content-Length: ${Buffer.byteLength(payload)}`,
    "Connection: close",
    "",
    payload,
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => socket.write(request));
    // Resolve once the status line and headers have arrived: a successful
    // MCP response is an SSE stream that does not end on its own.
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      const end = data.indexOf("\r\n\r\n");
      if (end !== -1) {
        const head = data.slice(0, end);
        socket.destroy();
        resolve({ status: Number(head.split(" ")[1]), head });
      }
    });
    socket.on("error", reject);
  });
}

async function connectClient(base: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  clients = [];
  await new Promise<void>((resolve) =>
    httpServer ? httpServer.close(() => resolve()) : resolve(),
  );
  httpServer = undefined;
  // No token value may ever appear in logs.
  for (const line of logs) {
    expect(line).not.toContain(roToken);
    expect(line).not.toContain(rwToken);
  }
});

describe("configuration", () => {
  it("refuses to create a server without tokens", () => {
    expect(() =>
      createHttpServer({ tokens: [], createMcpServer: () => { throw new Error("unused"); } }),
    ).toThrow(/at least one auth token/);
  });
});

describe("unauthenticated routes", () => {
  it("serves /healthz without credentials and without library data", async () => {
    const { base, factory } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect((await fetch(`${base}/healthz`, { method: "HEAD" })).status).toBe(200);
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown paths", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/sse`)).status).toBe(404);
    expect((await fetch(`${base}/messages`, { method: "POST" })).status).toBe(404);
  });
});

describe("authentication", () => {
  it.each([
    ["no Authorization header", {}],
    ["a wrong bearer token", { Authorization: `Bearer ${randomBytes(32).toString("base64url")}` }],
    ["Basic auth", { Authorization: `Basic ${Buffer.from(`u:${roToken}`).toString("base64")}` }],
    ["the bare token without scheme", { Authorization: roToken }],
    ["the server-side hash as token", { Authorization: `Bearer ${hashToken(roToken).toString("hex")}` }],
  ])("rejects initialize with %s", async (_name, auth) => {
    const { base, factory } = await start();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, ...auth },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="zotero-mcp"');
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32001 } });
    expect(factory).not.toHaveBeenCalled();
    expect(stub.getItem).not.toHaveBeenCalled();
  });

  it("ignores tokens passed in the query string", async () => {
    const { base, factory } = await start();
    const res = await fetch(`${base}/mcp?token=${roToken}&access_token=${roToken}`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects GET and DELETE on /mcp without credentials", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/mcp`, { headers: { Accept: "text/event-stream" } })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: "DELETE" })).status).toBe(401);
  });

  it("authenticates before reading the request body", async () => {
    const { base } = await start({ maxBodyBytes: 10 });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
  });

  describe("repeated Authorization headers (raw HTTP)", () => {
    const other = randomBytes(32).toString("base64url");

    it("accepts a single valid header sent over a raw socket (control)", async () => {
      const { base } = await start();
      const res = await rawPost(base, [`Authorization: Bearer ${roToken}`], INIT_BODY);
      expect(res.status).toBe(200);
      expect(res.head.toLowerCase()).toContain("mcp-session-id:");
    });

    it.each([
      ["valid first, unknown second", [`Authorization: Bearer ${roToken}`, `Authorization: Bearer ${other}`]],
      ["valid first, garbage second", [`Authorization: Bearer ${roToken}`, "Authorization: x"]],
      ["the same valid token twice", [`Authorization: Bearer ${roToken}`, `Authorization: Bearer ${roToken}`]],
      ["two valid tokens", [`Authorization: Bearer ${roToken}`, `Authorization: Bearer ${rwToken}`]],
      ["different name casing", [`Authorization: Bearer ${roToken}`, `authorization: Bearer ${roToken}`]],
      ["comma-joined values in one header", [`Authorization: Bearer ${roToken}, Bearer ${other}`]],
    ])("rejects initialize with %s", async (_name, lines) => {
      const { base, factory } = await start();
      const res = await rawPost(base, lines, INIT_BODY);
      expect(res.status).toBe(401);
      expect(res.head.toLowerCase()).not.toContain("mcp-session-id:");
      expect(factory).not.toHaveBeenCalled();
    });

    it("rejects duplicates on an established session", async () => {
      const { base } = await start();
      const { transport } = await connectClient(base, roToken);
      const res = await rawPost(
        base,
        [
          `mcp-session-id: ${transport.sessionId}`,
          "mcp-protocol-version: 2025-03-26",
          `Authorization: Bearer ${roToken}`,
          `Authorization: Bearer ${other}`,
        ],
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      );
      expect(res.status).toBe(401);
    });
  });

  it("logs rejections without credentials", async () => {
    const { base } = await start();
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${"x".repeat(40)}` },
      body: JSON.stringify(INIT_BODY),
    });
    expect(logs).toContain("[auth] rejected POST /mcp");
    expect(logs.join("\n")).not.toContain("x".repeat(40));
  });
});

describe("authenticated sessions", () => {
  it("lets a valid token use the read tools through the real MCP client", async () => {
    const { base } = await start();
    const { client } = await connectClient(base, roToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());

    const result = await client.callTool({ name: "search_items", arguments: { query: "price" } });
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/^\*\*Found 1 items\*\*/);
    const pdf = await client.callTool({ name: "read_attachment", arguments: { itemKey: "ITEM1234" } });
    expect((pdf.content as Array<{ type: string }>)[1].type).toBe("resource");
    expect(logs).toContain("[session] opened client=claude write=false");
  });

  it.each([
    ["writes disabled server-wide, rw token", false, rwToken, READ_TOOLS],
    ["writes enabled, ro token", true, roToken, READ_TOOLS],
    ["writes enabled, rw token", true, rwToken, [...READ_TOOLS, ...WRITE_TOOLS]],
  ] as const)("exposes the right tools with %s", async (_name, enableWrite, token, expected) => {
    const { base } = await start({ enableWrite });
    const { client } = await connectClient(base, token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...expected].sort());
  });

  it("is read-only by default even for an rw token", async () => {
    const { base } = await start();
    const { client } = await connectClient(base, rwToken);
    const result = await client.callTool({
      name: "create_note",
      arguments: { title: "x", content: "<p>x</p>" },
    });
    expect(result.isError).toBe(true);
    expect(stub.createNote).not.toHaveBeenCalled();
  });

  it("binds a session to the token that created it", async () => {
    const { base } = await start();
    const { transport } = await connectClient(base, roToken);
    const sessionId = transport.sessionId!;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const listBody = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const asOther = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
        Authorization: `Bearer ${rwToken}`,
      },
      body: listBody,
    });
    expect(asOther.status).toBe(404);

    const anonymous = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
      body: listBody,
    });
    expect(anonymous.status).toBe(401);
  });

  it("returns 404 for an unknown session ID", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        "mcp-session-id": "00000000-0000-0000-0000-000000000000",
        Authorization: `Bearer ${roToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("request limits", () => {
  const authed = { ...MCP_HEADERS, Authorization: `Bearer ${roToken}` };

  it("requires initialize when no session is given", async () => {
    const { base, factory } = await start();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: authed, body: "{not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
  });

  it("rejects oversized bodies", async () => {
    const { base } = await start({ maxBodyBytes: 64 });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ ...INIT_BODY, padding: "x".repeat(200) }),
    });
    expect(res.status).toBe(413);
  });

  it("caps concurrent sessions", async () => {
    const { base } = await start({ maxSessions: 1 });
    await connectClient(base, roToken);
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(503);
  });

  it("enforces the Host allowlist when configured", async () => {
    const { base } = await start({ allowedHosts: ["zotero-mcp.internal:3000"] });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(403);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
