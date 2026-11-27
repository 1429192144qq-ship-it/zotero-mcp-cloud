/**
 * Zotero Web API v3 client with rate limiting.
 *
 * Handles all HTTP communication with the Zotero API including
 * authentication, rate limiting (1 req/sec), pagination, and
 * write tokens for mutating operations.
 *
 * @see https://www.zotero.org/support/dev/web_api/v3/basics
 */

import { createHash, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const MAX_ARCHIVE_PDF_BYTES = 16 * 1024 * 1024;

export class ArchiveError extends Error {}

type UploadAuthorization =
  | { exists: 1 }
  | { url: string; uploadKey: string; contentType: string; prefix: string; suffix: string };

type ArchiveAccess = { library?: boolean; write?: boolean; files?: boolean };

export interface ZoteroConfig {
  apiKey: string;
  libraryId: string;
  baseUrl?: string; // default: "https://api.zotero.org"
  libraryType?: "user" | "group"; // default: "user"
  isLocal?: boolean; // default: false — when true, connects to Zotero Desktop local API
}

export interface ZoteroCollectionData {
  key: string;
  name: string;
  parentCollection: string | false;
  version: number;
}

export interface ZoteroCollection {
  key: string;
  version: number;
  library: { type: string; id: number; name: string };
  data: ZoteroCollectionData;
}

export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroTag {
  tag: string;
  type?: number;
}

export interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  title?: string;
  note?: string;
  creators?: ZoteroCreator[];
  tags?: ZoteroTag[];
  collections?: string[];
  date?: string;
  abstractNote?: string;
  DOI?: string;
  url?: string;
  [field: string]: unknown;
}

export interface ZoteroItem {
  key: string;
  version: number;
  library: { type: string; id: number; name: string };
  data: ZoteroItemData;
}

export interface ZoteroWriteResponse {
  success: Record<string, string>;
  unchanged: Record<string, string>;
  failed: Record<string, { code: number; message: string }>;
}

export interface PaginatedResult<T> {
  items: T[];
  totalResults: number;
  offset: number;
  limit: number;
}

/** Attachment-specific fields returned by Zotero API. */
export interface ZoteroAttachmentData {
  key: string;
  version: number;
  itemType: "attachment";
  title?: string;
  parentItem?: string;
  contentType?: string;
  filename?: string;
  linkMode: "imported_file" | "linked_file" | "linked_url" | "imported_url";
  path?: string;
  url?: string;
  accessDate?: string;
  tags?: ZoteroTag[];
  collections?: string[];
  [field: string]: unknown;
}

/** Full-text content returned by Zotero fulltext endpoint. */
export interface ZoteroFullText {
  content: string;
  indexedPages?: number;
  totalPages?: number;
  indexedChars?: number;
  totalChars?: number;
}

/** Summarised attachment info for tool output. */
export interface AttachmentInfo {
  key: string;
  title: string;
  contentType: string;
  filename: string;
  linkMode: string;
  localPath?: string;
  fileSize?: number;
}

// ---------------------------------------------------------------------------
// ZoteroClient
// ---------------------------------------------------------------------------

export class ZoteroClient {
  private readonly apiKey: string;
  private readonly libraryId: string;
  private readonly baseUrl: string;
  private readonly libraryType: "user" | "group";
  private readonly isLocal: boolean;
  private lastRequestTime = 0;
  private backoffUntil = 0;

  private static readonly MIN_INTERVAL_MS = 1000; // 1 req/sec

  constructor(config: ZoteroConfig) {
    this.apiKey = config.apiKey;
    this.libraryId = config.libraryId;
    this.libraryType = config.libraryType ?? "user";
    this.isLocal = config.isLocal ?? false;
    this.baseUrl = (config.baseUrl ?? "https://api.zotero.org").replace(
      /\/$/,
      "",
    );
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Base URL prefix for library endpoints (user or group). */
  private get userPrefix(): string {
    const segment = this.libraryType === "group" ? "groups" : "users";
    return `${this.baseUrl}/${segment}/${this.libraryId}`;
  }

  /** Common headers for every request. Omits API key in local mode. */
  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "Zotero-API-Version": "3",
      "Content-Type": "application/json",
      ...extra,
    };
    if (!this.isLocal) {
      h["Zotero-API-Key"] = this.apiKey;
    }
    return h;
  }

  /**
   * Rate-limited fetch wrapper.
   *
   * Enforces a minimum interval of 1 second between requests and
   * respects Backoff / Retry-After headers returned by the API.
   */
  private async rateLimitedFetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    // Honour server-requested backoff
    const now = Date.now();
    if (this.backoffUntil > now) {
      await this.sleep(this.backoffUntil - now);
    }

    // Enforce 1 req/sec minimum interval
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < ZoteroClient.MIN_INTERVAL_MS) {
      await this.sleep(ZoteroClient.MIN_INTERVAL_MS - elapsed);
    }

    this.lastRequestTime = Date.now();
    const response = await fetch(url, init);

    // Handle Backoff header (seconds to wait before next request)
    const backoff = response.headers.get("Backoff");
    if (backoff) {
      this.backoffUntil = Date.now() + parseInt(backoff, 10) * 1000;
    }

    // Handle 429 Too Many Requests
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
      console.error(`Rate limited. Waiting ${waitMs}ms before retry…`);
      await this.sleep(waitMs);
      this.lastRequestTime = Date.now();
      return fetch(url, init);
    }

    return response;
  }

  /** Throw a descriptive error based on HTTP status. */
  private async throwOnError(response: Response, context: string): Promise<void> {
    if (response.ok) return;

    const status = response.status;
    await response.body?.cancel().catch(() => undefined);

    const messages: Record<number, string> = {
      400: "Bad request — check parameters",
      403: "Forbidden — invalid API key or insufficient permissions",
      404: "Not found — check the key or library ID",
      409: "Conflict — the library is currently locked; try again later",
      412: "Precondition failed — item was modified by another client",
      413: "Request too large",
      429: "Rate limit exceeded",
      503: "Zotero service temporarily unavailable",
    };

    const msg = messages[status] ?? `HTTP ${status}`;
    throw new Error(`${context}: ${msg}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -------------------------------------------------------------------------
  // Public API methods
  // -------------------------------------------------------------------------

  /**
   * List collections in the library with pagination support.
   */
  async listCollections(params?: {
    limit?: number;
    offset?: number;
  }): Promise<PaginatedResult<ZoteroCollection>> {
    const limit = params?.limit ?? 25;
    const offset = params?.offset ?? 0;

    const url = `${this.userPrefix}/collections?limit=${limit}&start=${offset}&format=json`;
    const response = await this.rateLimitedFetch(url, {
      headers: this.headers(),
    });

    await this.throwOnError(response, "listCollections");

    const items: ZoteroCollection[] = await response.json() as ZoteroCollection[];
    const totalResults = parseInt(
      response.headers.get("Total-Results") ?? String(items.length),
      10,
    );

    return { items, totalResults, offset, limit };
  }

  /**
   * Create a new collection. Returns the Zotero write response.
   */
  async createCollection(
    name: string,
    parentCollection?: string,
  ): Promise<ZoteroWriteResponse> {
    const url = `${this.userPrefix}/collections`;
    const body = [
      {
        name,
        ...(parentCollection ? { parentCollection } : {}),
      },
    ];

    const response = await this.rateLimitedFetch(url, {
      method: "POST",
      headers: this.headers({ "Zotero-Write-Token": randomUUID() }),
      body: JSON.stringify(body),
    });

    await this.throwOnError(response, "createCollection");
    return (await response.json()) as ZoteroWriteResponse;
  }

  /**
   * Create a standalone note. Optionally add it to collections and tag it.
   */
  async createNote(
    noteHtml: string,
    collectionKeys?: string[],
    tags?: ZoteroTag[],
  ): Promise<ZoteroWriteResponse> {
    const url = `${this.userPrefix}/items`;
    const body = [
      {
        itemType: "note",
        note: noteHtml,
        tags: tags ?? [],
        collections: collectionKeys ?? [],
      },
    ];

    const response = await this.rateLimitedFetch(url, {
      method: "POST",
      headers: this.headers({ "Zotero-Write-Token": randomUUID() }),
      body: JSON.stringify(body),
    });

    await this.throwOnError(response, "createNote");
    return (await response.json()) as ZoteroWriteResponse;
  }

  get supportsArchive(): boolean {
    return !this.isLocal;
  }

  /** Inspect the effective API-key grant without mutating the target library. */
  async archiveAccess(): Promise<{ libraryWrite: boolean; fileWrite: boolean; maxPdfBytes: number }> {
    const response = await this.rateLimitedFetch(`${this.baseUrl}/keys/current`, {
      headers: this.headers(),
      redirect: "error",
    });
    await this.throwOnError(response, "archiveAccess");
    const key = await response.json() as {
      userID?: number;
      access?: { user?: ArchiveAccess; groups?: Record<string, ArchiveAccess> };
    };
    const access = this.libraryType === "user"
      ? (String(key.userID) === this.libraryId ? key.access?.user : undefined)
      : key.access?.groups?.[this.libraryId] ?? key.access?.groups?.all;
    let libraryWrite = access?.library === true && access.write === true;
    let fileWrite = libraryWrite && access?.files === true;
    if (libraryWrite && this.libraryType === "group") {
      const response = await this.rateLimitedFetch(this.userPrefix, {
        headers: this.headers(),
        redirect: "error",
      });
      await this.throwOnError(response, "archive group permissions");
      const group = (await response.json() as {
        data: { owner: number; admins?: number[]; members?: number[]; libraryEditing: string; fileEditing: string };
      }).data;
      const admin = key.userID === group.owner || group.admins?.includes(key.userID ?? -1);
      const member = group.members?.includes(key.userID ?? -1);
      libraryWrite = Boolean(admin || (member && group.libraryEditing === "members"));
      fileWrite = libraryWrite &&
        (group.fileEditing === "members" || (Boolean(admin) && group.fileEditing === "admins"));
    }
    return { libraryWrite, fileWrite, maxPdfBytes: MAX_ARCHIVE_PDF_BYTES };
  }

  private async createArchiveItem(data: Record<string, unknown>, writeToken: string): Promise<ZoteroItem> {
    const response = await this.rateLimitedFetch(`${this.userPrefix}/items`, {
      method: "POST",
      redirect: "error",
      headers: this.headers({ "Zotero-Write-Token": writeToken }),
      body: JSON.stringify([data]),
    });
    if (response.status === 412) {
      await response.body?.cancel();
      throw new ArchiveError("Write token was already accepted. Find the existing item before retrying.");
    }
    await this.throwOnError(response, "createArchiveItem");
    const result = await response.json() as {
      successful?: Record<string, ZoteroItem>;
      failed?: Record<string, { code: number }>;
    };
    const created = result.successful?.["0"];
    if (!created || !/^[A-Z0-9]{8}$/.test(created.key)) {
      const code = result.failed?.["0"]?.code;
      throw new ArchiveError(`Zotero did not create the item${Number.isInteger(code) ? ` (code ${code})` : ""}.`);
    }
    return created;
  }

  async createBibliography(itemType: string, fields: Record<string, unknown>, writeToken: string) {
    const item = await this.createArchiveItem({ ...fields, itemType }, writeToken);
    return { itemKey: item.key, version: item.version };
  }

  private async bibliography(itemKey: string, expectedVersion?: number): Promise<ZoteroItem> {
    const item = await this.getItem(itemKey);
    if (["attachment", "note", "annotation"].includes(item.data.itemType) || item.data.parentItem) {
      throw new ArchiveError("The item must be a top-level bibliography record.");
    }
    if (expectedVersion !== undefined && item.version !== expectedVersion) {
      throw new ArchiveError("The item version changed. Read the record again before editing.");
    }
    return item;
  }

  private async patchBibliography(item: ZoteroItem, fields: Record<string, unknown>) {
    if (Object.keys(fields).length === 0) return { itemKey: item.key, version: item.version };
    const response = await this.rateLimitedFetch(`${this.userPrefix}/items/${item.key}`, {
      method: "PATCH",
      redirect: "error",
      headers: this.headers({ "If-Unmodified-Since-Version": String(item.version) }),
      body: JSON.stringify(fields),
    });
    if (response.status === 412) {
      await response.body?.cancel();
      throw new ArchiveError("The item changed during the request. Read it again before editing.");
    }
    await this.throwOnError(response, "patchBibliography");
    const version = Number(response.headers.get("Last-Modified-Version"));
    return { itemKey: item.key, version: version || (await this.getItem(item.key)).version };
  }

  async editBibliography(itemKey: string, version: number, fields: Record<string, unknown>) {
    return this.patchBibliography(await this.bibliography(itemKey, version), fields);
  }

  async setLiteratureNumberTag(itemKey: string, version: number, literatureId: string) {
    const item = await this.bibliography(itemKey, version);
    this.checkArchiveLocation(item, literatureId);
    const canonical = `文献番号: ${literatureId}`;
    const tags = item.data.tags ?? [];
    const numbered = tags.filter(({ tag }) => /^文献番号\s*[:：]/u.test(tag));
    if (numbered.some(({ tag }) => tag.split(/[:：]/u)[1]?.trim() !== literatureId)) {
      throw new ArchiveError("A different permanent number tag already exists. Resolve the conflict in the registry.");
    }
    if (numbered.length === 1 && numbered[0].tag === canonical) {
      return { itemKey, version };
    }
    return this.patchBibliography(item, {
      tags: [...tags.filter(({ tag }) => !/^文献番号\s*[:：]/u.test(tag)), { tag: canonical }],
    });
  }

  private checkArchiveLocation(item: ZoteroItem, literatureId: string) {
    const current = item.data.archiveLocation;
    if (current && current !== literatureId) {
      throw new ArchiveError("archiveLocation already has a different value. Resolve the conflict in the registry.");
    }
  }

  async setArchiveLocation(itemKey: string, version: number, literatureId: string) {
    const item = await this.bibliography(itemKey, version);
    this.checkArchiveLocation(item, literatureId);
    const numbers = (item.data.tags ?? []).filter(({ tag }) => /^文献番号\s*[:：]/u.test(tag));
    if (numbers.some(({ tag }) => tag.split(/[:：]/u)[1]?.trim() !== literatureId)) {
      throw new ArchiveError("The permanent number tag conflicts with archiveLocation.");
    }
    return this.patchBibliography(item, item.data.archiveLocation === literatureId
      ? {} : { archiveLocation: literatureId });
  }

  private async findArchiveAttachment(parentKey: string, filename: string): Promise<ZoteroItem | undefined> {
    const matches: ZoteroItem[] = [];
    for (let start = 0; ; start += 100) {
      const url = `${this.userPrefix}/items/${parentKey}/children?format=json&limit=100&start=${start}`;
      const response = await this.rateLimitedFetch(url, { headers: this.headers(), redirect: "error" });
      await this.throwOnError(response, "findArchiveAttachment");
      const children = await response.json() as ZoteroItem[];
      matches.push(...children.filter(({ data }) => data.itemType === "attachment" && data.filename === filename));
      if (children.length < 100) break;
    }
    if (matches.length > 1) throw new ArchiveError("More than one child attachment has this archive filename.");
    const match = matches[0];
    if (match && (match.data.linkMode !== "imported_file" || match.data.contentType !== "application/pdf")) {
      throw new ArchiveError("An incompatible attachment already uses this archive filename.");
    }
    return match;
  }

  async uploadArchivePdf(parentKey: string, literatureId: string, bytes: Buffer) {
    if (bytes.length > MAX_ARCHIVE_PDF_BYTES || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new ArchiveError("Provide a PDF with a %PDF- header and at most 16 MiB.");
    }
    const parent = await this.bibliography(parentKey);
    const tags = (parent.data.tags ?? []).filter(({ tag }) => /^文献番号\s*[:：]/u.test(tag));
    if (parent.data.archiveLocation !== literatureId || tags.length !== 1 ||
        tags[0].tag !== `文献番号: ${literatureId}`) {
      throw new ArchiveError("Set the matching canonical number tag and archiveLocation on the parent first.");
    }

    const filename = `${literatureId}.pdf`;
    const md5 = createHash("md5").update(bytes).digest("hex");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let attachment = await this.findArchiveAttachment(parentKey, filename);
    if (!attachment) {
      const writeToken = createHash("sha256").update(`archive-pdf:${this.libraryType}:${this.libraryId}:${parentKey}:${filename}`)
        .digest("hex").slice(0, 32);
      attachment = await this.createArchiveItem({
        itemType: "attachment", linkMode: "imported_file", parentItem: parentKey,
        title: filename, filename, contentType: "application/pdf",
      }, writeToken);
    }
    const attachmentKey = attachment.key;
    if (attachment.data.md5 && attachment.data.md5 !== md5) {
      throw new ArchiveError("The existing numbered PDF has different bytes. No file was overwritten.");
    }

    if (!attachment.data.md5) {
      await this.transferArchivePdf(attachmentKey, filename, md5, bytes);
    }
    const downloaded = await this.downloadAttachment(attachmentKey);
    const actual = createHash("sha256").update(Buffer.from(downloaded.data, "base64")).digest("hex");
    if (actual !== sha256) throw new ArchiveError("The downloaded PDF does not match the supplied bytes.");
    return { parentKey, attachmentKey, filename, bytes: bytes.length, sha256 };
  }

  private async transferArchivePdf(attachmentKey: string, filename: string, md5: string, bytes: Buffer) {
    const url = `${this.userPrefix}/items/${attachmentKey}/file`;
    const postForm = (data: Record<string, string>) => this.rateLimitedFetch(url, {
      method: "POST",
      redirect: "error",
      headers: this.headers({
        "Content-Type": "application/x-www-form-urlencoded",
        "If-None-Match": "*",
      }),
      body: new URLSearchParams(data),
      signal: AbortSignal.timeout(30_000),
    });
    const authorization = await postForm({
      md5, filename, filesize: String(bytes.length), mtime: String(Date.now()),
    });
    await this.throwOnError(authorization, "authorize PDF upload");
    const upload = await authorization.json() as UploadAuthorization;
    if ("exists" in upload && upload.exists === 1) return;
    if (!("url" in upload) || typeof upload.url !== "string" ||
        typeof upload.uploadKey !== "string" || !upload.uploadKey ||
        typeof upload.contentType !== "string" || !upload.contentType.startsWith("multipart/form-data;") ||
        typeof upload.prefix !== "string" || typeof upload.suffix !== "string") {
      throw new ArchiveError("Unexpected PDF upload authorization response.");
    }
    const storage = new URL(upload.url);
    if (storage.protocol !== "https:" || (storage.port && storage.port !== "443") ||
        storage.username || storage.password ||
        !storage.hostname.endsWith(".amazonaws.com") ||
        (this.apiKey && storage.href.includes(this.apiKey))) {
      throw new ArchiveError("The authorized PDF storage destination was rejected.");
    }
    // Only the signed form is sent to storage. No Zotero credential is forwarded.
    const transfer = await fetch(storage, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": upload.contentType },
      body: new Uint8Array(Buffer.concat([Buffer.from(upload.prefix), bytes, Buffer.from(upload.suffix)])),
      signal: AbortSignal.timeout(180_000),
    });
    await this.throwOnError(transfer, "transfer PDF bytes");
    await transfer.body?.cancel();
    const registered = await postForm({ upload: upload.uploadKey });
    await this.throwOnError(registered, "register PDF upload");
    await registered.body?.cancel();
  }

  /**
   * Retrieve a single item by key.
   */
  async getItem(itemKey: string): Promise<ZoteroItem> {
    const url = `${this.userPrefix}/items/${itemKey}?format=json`;
    const response = await this.rateLimitedFetch(url, {
      headers: this.headers(),
    });

    await this.throwOnError(response, `getItem(${itemKey})`);
    return (await response.json()) as ZoteroItem;
  }

  /**
   * Add an existing item to a collection.
   *
   * Fetches the item first to get its current version and collections,
   * then patches with the new collection key appended.
   */
  async addItemToCollection(
    itemKey: string,
    collectionKey: string,
  ): Promise<void> {
    // 1. Get current item state
    const item = await this.getItem(itemKey);
    const currentCollections = item.data.collections ?? [];

    if (currentCollections.includes(collectionKey)) {
      return; // Already in the collection
    }

    // 2. Patch with new collection list
    const url = `${this.userPrefix}/items/${itemKey}`;
    const response = await this.rateLimitedFetch(url, {
      method: "PATCH",
      headers: this.headers({
        "If-Unmodified-Since-Version": String(item.version),
      }),
      body: JSON.stringify({
        collections: [...currentCollections, collectionKey],
      }),
    });

    await this.throwOnError(response, `addItemToCollection(${itemKey})`);
  }

  /**
   * Download an attachment file from the Zotero API.
   * Returns the file as a base64-encoded string together with metadata.
   */
  async downloadAttachment(
    itemKey: string,
  ): Promise<{ data: string; contentType: string; filename: string }> {
    const url = `${this.userPrefix}/items/${itemKey}/file`;
    let current = new URL(url);
    let response: Response | undefined;
    for (let hop = 0; hop <= 5; hop++) {
      if (!this.isLocal && (current.protocol !== "https:" || current.port && current.port !== "443" || current.username || current.password ||
          !["api.zotero.org", "zotero.org"].includes(current.hostname) && !current.hostname.endsWith(".amazonaws.com") && !current.hostname.endsWith(".cloudfront.net"))) {
        throw new Error("Attachment redirect blocked by credential boundary");
      }
      response = await this.rateLimitedFetch(current.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(180_000),
        headers: hop === 0 ? this.headers({"Accept-Encoding":"identity"}) : {"Accept-Encoding":"identity"},
      });
      if (![301,302,303,307,308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hop === 5) throw new Error("Attachment redirect unavailable or limit exceeded");
      current = new URL(location, current);
      if (this.apiKey && current.href.includes(this.apiKey)) throw new Error("Unsafe attachment redirect");
    }
    if (!response) throw new Error("Attachment response unavailable");
    await this.throwOnError(response, "downloadAttachment");

    const contentType =
      response.headers.get("Content-Type") ?? "application/octet-stream";
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
    const filename = filenameMatch?.[1] ?? `${itemKey}.bin`;

    if (!response.body) throw new Error("Attachment body unavailable");
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024 * 1024) throw new Error("Attachment exceeds 64 MiB read limit");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const expected = response.headers.get("content-length");
    if (expected !== null && Number(expected) !== size) throw new Error("Attachment incomplete; cloud status unconfirmed");
    const data = Buffer.concat(chunks).toString("base64");

    return { data, contentType, filename };
  }

  /**
   * Retrieve the full-text content indexed by Zotero for the given item.
   * Returns null if the item has not been indexed.
   */
  async getFullText(itemKey: string): Promise<ZoteroFullText | null> {
    const url = `${this.userPrefix}/items/${itemKey}/fulltext`;
    const response = await this.rateLimitedFetch(url, {
      headers: this.headers(),
    });

    if (response.status === 404) return null;
    await this.throwOnError(response, `getFullText(${itemKey})`);
    return (await response.json()) as ZoteroFullText;
  }

  /**
   * List child items (attachments, notes) of a parent item.
   * Optionally filter to only attachment items.
   */
  async getItemChildren(
    itemKey: string,
    attachmentsOnly = false,
  ): Promise<ZoteroItem[]> {
    const url = `${this.userPrefix}/items/${itemKey}/children?format=json`;
    const response = await this.rateLimitedFetch(url, {
      headers: this.headers(),
    });

    await this.throwOnError(response, `getItemChildren(${itemKey})`);
    const items: ZoteroItem[] = (await response.json()) as ZoteroItem[];

    if (attachmentsOnly) {
      return items.filter((i) => i.data.itemType === "attachment");
    }
    return items;
  }

  /**
   * Search for items in the library with pagination.
   */
  async searchItems(params: {
    query: string;
    qmode?: "titleCreatorYear" | "everything";
    itemType?: string;
    tag?: string;
    sort?: string;
    direction?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<PaginatedResult<ZoteroItem>> {
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    const qmode = params.qmode ?? "titleCreatorYear";
    const sort = params.sort ?? "dateModified";
    const direction = params.direction ?? "desc";

    const searchParams = new URLSearchParams({
      q: params.query,
      qmode,
      sort,
      direction,
      limit: String(limit),
      start: String(offset),
      format: "json",
    });

    if (params.itemType) {
      searchParams.set("itemType", params.itemType);
    }
    if (params.tag) {
      searchParams.set("tag", params.tag);
    }

    const url = `${this.userPrefix}/items?${searchParams.toString()}`;
    const response = await this.rateLimitedFetch(url, {
      headers: this.headers(),
    });

    await this.throwOnError(response, "searchItems");

    const items: ZoteroItem[] = await response.json() as ZoteroItem[];
    const totalResults = parseInt(
      response.headers.get("Total-Results") ?? String(items.length),
      10,
    );

    return { items, totalResults, offset, limit };
  }
}
