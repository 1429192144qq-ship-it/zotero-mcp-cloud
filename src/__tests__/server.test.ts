/**
 * Tool registry tests (server.ts): read-only default, write gating, input
 * validation, and compatibility of the existing read tools' output.
 * Uses an in-memory MCP link and a stub ZoteroClient — no network, no library.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ZoteroClient } from "../zotero-api.js";
import {
  READ_TOOLS,
  WRITE_TOOLS,
  createZoteroServer,
  type ZoteroServerOptions,
} from "../server.js";
import { FIXTURES, createStubZotero, type StubZotero } from "./helpers.js";

type TextContent = { type: "text"; text: string };

async function connect(stub: StubZotero, options: ZoteroServerOptions = {}) {
  const server = createZoteroServer(stub as unknown as ZoteroClient, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function firstText(result: { content?: unknown }): string {
  return ((result.content as TextContent[])[0]).text;
}

let stub: StubZotero;
let client: Client;

beforeEach(() => {
  stub = createStubZotero();
});

afterEach(async () => {
  await client?.close();
});

describe("tool registration", () => {
  it("is read-only by default: only read tools are advertised", async () => {
    ({ client } = await connect(stub));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
  });

  it("refuses write tools in read-only mode without calling Zotero", async () => {
    ({ client } = await connect(stub));
    for (const name of WRITE_TOOLS) {
      const result = await client.callTool({
        name,
        arguments: { name: "x", title: "x", content: "x", itemKey: "ITEM1234", collectionKey: "ABC12345" },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/not found/i);
    }
    expect(stub.createCollection).not.toHaveBeenCalled();
    expect(stub.createNote).not.toHaveBeenCalled();
    expect(stub.addItemToCollection).not.toHaveBeenCalled();
  });

  it("registers all nine tools when writes are allowed", async () => {
    ({ client } = await connect(stub, { allowWrite: true }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
    );
    const result = await client.callTool({
      name: "create_note",
      arguments: { title: "T", content: "<p>c</p>" },
    });
    expect(result.isError).toBeFalsy();
    expect(stub.createNote).toHaveBeenCalledOnce();
  });

  it("keeps the original input parameters of the read tools", async () => {
    ({ client } = await connect(stub));
    const { tools } = await client.listTools();
    const params = Object.fromEntries(
      tools.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {}).sort()]),
    );
    expect(params).toEqual({
      list_collections: ["limit", "offset"],
      get_item: ["itemKey"],
      search_items: ["direction", "itemType", "limit", "offset", "qmode", "query", "sort", "tag"],
      get_item_attachments: ["forceRemote", "itemKey"],
      get_item_fulltext: ["forceRemote", "itemKey"],
      read_attachment: ["forceRemote", "itemKey"],
    });
  });
});

describe("input validation", () => {
  it.each(["../../etc/passwd", "ITEM123", "item1234", "ITEM12345", "ITEM/234"])(
    "rejects malformed item key %j before reaching Zotero",
    async (itemKey) => {
      ({ client } = await connect(stub));
      for (const name of ["get_item", "get_item_attachments", "get_item_fulltext", "read_attachment"]) {
        const result = await client.callTool({ name, arguments: { itemKey } });
        expect(result.isError).toBe(true);
      }
      expect(stub.getItem).not.toHaveBeenCalled();
      expect(stub.getItemChildren).not.toHaveBeenCalled();
    },
  );
});

describe("read tool compatibility", () => {
  beforeEach(async () => {
    ({ client } = await connect(stub));
  });

  it("search_items returns the Markdown summary format", async () => {
    const result = await client.callTool({
      name: "search_items",
      arguments: { query: "reference price", qmode: "everything", tag: "test" },
    });
    const text = firstText(result);
    expect(text.startsWith("**Found 1 items** (showing 1-1)")).toBe(true);
    expect(text).toContain("### Test Article");
    expect(text).toContain("`ITEM1234`");
    expect(stub.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({ query: "reference price", qmode: "everything", tag: "test" }),
    );
  });

  it("get_item returns full Markdown metadata", async () => {
    const text = firstText(await client.callTool({ name: "get_item", arguments: { itemKey: "ITEM1234" } }));
    expect(text).toContain("Test Article");
    expect(text).toContain("Doe");
  });

  it("list_collections returns the JSON listing", async () => {
    const data = JSON.parse(firstText(await client.callTool({ name: "list_collections", arguments: {} })));
    expect(data).toEqual({
      collections: [{ key: "ABC12345", name: "Test Collection", parentCollection: null }],
      totalResults: 1,
      offset: 0,
      limit: 25,
    });
  });

  it("get_item_attachments lists PDF attachments", async () => {
    const data = JSON.parse(
      firstText(await client.callTool({ name: "get_item_attachments", arguments: { itemKey: "ITEM1234" } })),
    );
    expect(data.totalAttachments).toBe(1);
    expect(data.attachments[0]).toMatchObject({
      key: "ATCH1234",
      contentType: "application/pdf",
      filename: "test-article.pdf",
    });
    expect(data.attachments[0].localPath).toBeUndefined();
  });

  it("get_item_fulltext resolves a parent item to its PDF and returns API text", async () => {
    const data = JSON.parse(
      firstText(await client.callTool({ name: "get_item_fulltext", arguments: { itemKey: "ITEM1234" } })),
    );
    expect(data).toMatchObject({
      itemKey: "ITEM1234",
      attachmentKey: "ATCH1234",
      source: "api",
      content: FIXTURES.fulltext.content,
    });
    expect(stub.getFullText).toHaveBeenCalledWith("ATCH1234");
  });

  it("read_attachment downloads via the API and returns a base64 resource", async () => {
    const result = await client.callTool({ name: "read_attachment", arguments: { itemKey: "ITEM1234" } });
    const meta = JSON.parse(firstText(result));
    expect(meta).toMatchObject({ attachmentKey: "ATCH1234", source: "api", contentType: "application/pdf" });
    const resource = (result.content as Array<{ type: string; resource?: { blob?: string; uri?: string } }>)[1];
    expect(resource.type).toBe("resource");
    expect(resource.resource?.uri).toBe("zotero://attachment/ATCH1234");
    expect(Buffer.from(resource.resource!.blob!, "base64").toString()).toBe("%PDF-1.4 test");
  });
});

describe("local file access", () => {
  it("is disabled when no dataDir is given (remote deployments)", async () => {
    ({ client } = await connect(stub));
    const meta = JSON.parse(
      firstText(await client.callTool({ name: "read_attachment", arguments: { itemKey: "ATCH1234" } })),
    );
    expect(meta.source).toBe("api");
    expect(stub.downloadAttachment).toHaveBeenCalledOnce();
  });

  it("still prefers local storage when a dataDir is configured (stdio)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zotero-mcp-test-"));
    mkdirSync(join(dataDir, "storage", "ATCH1234"), { recursive: true });
    writeFileSync(join(dataDir, "storage", "ATCH1234", "test-article.pdf"), "%PDF");
    writeFileSync(join(dataDir, "storage", "ATCH1234", ".zotero-ft-cache"), "cached text");

    ({ client } = await connect(stub, { dataDir }));
    const file = JSON.parse(
      firstText(await client.callTool({ name: "read_attachment", arguments: { itemKey: "ATCH1234" } })),
    );
    expect(file.source).toBe("local");
    const text = JSON.parse(
      firstText(await client.callTool({ name: "get_item_fulltext", arguments: { itemKey: "ATCH1234" } })),
    );
    expect(text).toMatchObject({ source: "local", content: "cached text" });
    expect(stub.downloadAttachment).not.toHaveBeenCalled();
  });
});
