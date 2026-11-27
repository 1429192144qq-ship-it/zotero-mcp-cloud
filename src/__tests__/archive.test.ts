import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createZoteroServer } from "../server.js";
import { ZoteroClient } from "../zotero-api.js";
import { mockFetch, mockResponse } from "./helpers.js";

const config = { apiKey: "mock-key", libraryId: "123" };
const api = "https://api.zotero.org/users/123";
const item = { key: "BOOK2345", version: 7, data: { itemType: "book", tags: [{ tag: "topic" }] } };
const attachment = { key: "FILE2345", version: 9, data: {
  itemType: "attachment", contentType: "application/pdf", linkMode: "imported_file", filename: "042.pdf",
} };
const pdf = Buffer.from("%PDF-1.4\nmock attachment bytes");
const archiveParent = { ...item, data: {
  ...item.data, tags: [{ tag: "文献番号: 042" }], archiveLocation: "042",
} };
const writeToken = "1234567890abcdef1234567890abcdef";
let fetchMock: ReturnType<typeof mockFetch>;
let zotero: ZoteroClient;
let client: Client | undefined;

beforeEach(() => {
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 1100));
  fetchMock = mockFetch();
  fetchMock.mockRejectedValue(new Error("Unexpected fetch: tests use fixtures only"));
  zotero = new ZoteroClient(config);
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.restoreAllMocks();
});

function reply(...options: Parameters<typeof mockResponse>[0][]) {
  for (const option of options) fetchMock.mockResolvedValueOnce(mockResponse(option));
}

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createZoteroServer(zotero, { allowWrite: true });
  client = new Client({ name: "archive-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

it("reads write and file grants without returning the API key or mutating data", async () => {
  reply({ body: { key: "mock-key", userID: 123, access: { user: { library: true, write: true, files: false } } } });
  const result = await (await connect()).callTool({ name: "check_archive_permissions", arguments: {} });
  expect(result.structuredContent).toEqual({ libraryWrite: true, fileWrite: false, maxPdfBytes: 16 * 1024 * 1024 });
  expect(JSON.stringify(result)).not.toContain("mock-key");
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
    ["https://api.zotero.org/keys/current", "GET"],
  ]);
});

it("checks group membership and file editing policy as well as key grants", async () => {
  const group = new ZoteroClient({ ...config, libraryType: "group" });
  reply(
    { body: { userID: 456, access: { groups: { all: { library: true, write: true } } } } },
    { body: { data: { owner: 333, members: [456], libraryEditing: "members", fileEditing: "admins" } } },
  );
  expect(await group.archiveAccess()).toMatchObject({ libraryWrite: true, fileWrite: false });
});

it("creates a parent item through MCP using Zotero's single-item write result", async () => {
  reply({ body: { successful: { 0: item }, failed: {} } });
  const result = await (await connect()).callTool({
    name: "create_bibliography", arguments: { itemType: "book", fields: { title: "Fixture" }, writeToken },
  });
  expect(result.structuredContent).toEqual({ itemKey: item.key, version: 7 });
  expect(fetchMock).toHaveBeenCalledWith(`${api}/items`, expect.objectContaining({
    method: "POST",
    headers: expect.objectContaining({ "Zotero-Write-Token": writeToken }),
    body: JSON.stringify([{ title: "Fixture", itemType: "book" }]),
  }));
});

it("edits metadata with a version precondition and rejects stale or reserved-field writes", async () => {
  reply({ body: item }, { status: 204, headers: { "Last-Modified-Version": "8" } }, { body: { ...item, version: 8 } });
  const mcp = await connect();
  const edit = { name: "edit_bibliography", arguments: { itemKey: item.key, version: 7, fields: { title: "Updated" } } };
  expect((await mcp.callTool(edit)).structuredContent).toEqual({ itemKey: item.key, version: 8 });
  expect(fetchMock.mock.calls[1][1]).toMatchObject({
    method: "PATCH", body: '{"title":"Updated"}', headers: { "If-Unmodified-Since-Version": "7" },
  });
  expect((await mcp.callTool(edit)).isError).toBe(true);
  expect((await mcp.callTool({ ...edit, arguments: {
    ...edit.arguments, fields: { archiveLocation: "999" },
  } })).isError).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("updates the number tag and archive location without losing unrelated tags", async () => {
  reply(
    { body: { ...item, data: { ...item.data, tags: [{ tag: "topic" }, { tag: "文献番号：042" }] } } },
    { status: 204, headers: { "Last-Modified-Version": "8" } },
    { body: { ...archiveParent, version: 8, data: { ...archiveParent.data, archiveLocation: "" } } },
    { status: 204, headers: { "Last-Modified-Version": "9" } },
    { body: { ...archiveParent, version: 9 } },
  );
  const mcp = await connect();
  const args = { itemKey: item.key, version: 7, literatureId: "042" };
  expect((await mcp.callTool({ name: "set_literature_number_tag", arguments: args })).structuredContent)
    .toMatchObject({ version: 8 });
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)))
    .toEqual({ tags: [{ tag: "topic" }, { tag: "文献番号: 042" }] });
  expect((await mcp.callTool({ name: "set_archive_location", arguments: { ...args, version: 8 } })).structuredContent)
    .toMatchObject({ version: 9 });
  expect(fetchMock.mock.calls[3][1]?.body).toBe('{"archiveLocation":"042"}');
  expect((await mcp.callTool({ name: "set_archive_location", arguments: { ...args, version: 9, literatureId: "043" } })).isError)
    .toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(5);
});

it("uploads actual PDF bytes, registers them, then checks the downloaded hash", async () => {
  reply(
    { body: archiveParent }, { body: [] }, { body: { successful: { 0: attachment } } },
    { body: { url: "https://fixtures.s3.amazonaws.com/", uploadKey: "fixture-upload", contentType: "multipart/form-data; boundary=x", prefix: "before", suffix: "after" } },
    { status: 201 }, { status: 204 },
  );
  fetchMock.mockResolvedValueOnce(new Response(pdf, { headers: { "Content-Length": String(pdf.length) } }));
  const result = await (await connect()).callTool({
    name: "upload_archive_pdf", arguments: { parentKey: item.key, literatureId: "042", pdfBase64: pdf.toString("base64") },
  });
  expect(result.structuredContent).toEqual({
    parentKey: item.key, attachmentKey: attachment.key, filename: "042.pdf",
    bytes: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex"),
  });
  const file = `${api}/items/${attachment.key}/file`;
  expect(fetchMock.mock.calls[3]).toEqual([file, expect.objectContaining({
    method: "POST",
    headers: expect.objectContaining({ "If-None-Match": "*" }),
    body: expect.any(URLSearchParams),
  })]);
  const authorization = fetchMock.mock.calls[3][1]?.body as URLSearchParams;
  expect(authorization.get("md5")).toBe(createHash("md5").update(pdf).digest("hex"));
  expect(authorization.get("filesize")).toBe(String(pdf.length));
  expect(String(fetchMock.mock.calls[4][0])).toBe("https://fixtures.s3.amazonaws.com/");
  expect(fetchMock.mock.calls[4][1]?.headers).toEqual({ "Content-Type": "multipart/form-data; boundary=x" });
  expect(Buffer.from(fetchMock.mock.calls[4][1]?.body as Uint8Array)).toEqual(
    Buffer.concat([Buffer.from("before"), pdf, Buffer.from("after")]),
  );
  expect(String(fetchMock.mock.calls[5][1]?.body)).toBe("upload=fixture-upload");
  expect(fetchMock.mock.calls[6][0]).toBe(file);
});

it("resumes an existing attachment after upstream deduplication and never overwrites different bytes", async () => {
  reply({ body: archiveParent }, { body: [attachment] }, { body: { exists: 1 } });
  fetchMock.mockResolvedValueOnce(new Response(pdf));
  expect(await zotero.uploadArchivePdf(item.key, "042", pdf)).toMatchObject({ attachmentKey: attachment.key });
  reply({ body: archiveParent }, { body: [{ ...attachment, data: { ...attachment.data, md5: "other" } }] });
  await expect(zotero.uploadArchivePdf(item.key, "042", pdf)).rejects.toThrow("No file was overwritten");
  expect(fetchMock).toHaveBeenCalledTimes(6);
});

it("stops on failed byte transfer and can retry a partial upload without creating a second child", async () => {
  const upload = { body: { url: "https://fixtures.s3.amazonaws.com/", uploadKey: "fixture-upload",
    contentType: "multipart/form-data; boundary=x", prefix: "before", suffix: "after" } };
  reply({ body: archiveParent }, { body: [attachment] }, upload, { status: 403 });
  await expect(zotero.uploadArchivePdf(item.key, "042", pdf)).rejects.toThrow("transfer PDF bytes");
  expect(fetchMock).toHaveBeenCalledTimes(4);
  reply({ body: archiveParent }, { body: [attachment] }, { body: { exists: 1 } });
  fetchMock.mockResolvedValueOnce(new Response(Buffer.from("different data")));
  await expect(zotero.uploadArchivePdf(item.key, "042", pdf)).rejects.toThrow("does not match");
});
