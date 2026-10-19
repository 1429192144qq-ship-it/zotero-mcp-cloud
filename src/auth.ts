/**
 * Static bearer-token authentication for the HTTP transport.
 *
 * The server never stores plaintext tokens. MCP_AUTH_TOKEN_HASHES holds one
 * entry per client:
 *
 *   label:sha256hex[:ro|rw]
 *
 * Entries are separated by commas or whitespace. `label` identifies the client
 * in logs (e.g. "claude", "codex"); the access level defaults to "ro".
 * Clients send `Authorization: Bearer <token>`; the server hashes the token
 * and compares it in constant time against every configured hash.
 *
 * Generate a token and its entry with `npm run token:generate -- <label>`.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export interface TokenEntry {
  label: string;
  hash: Buffer;
  canWrite: boolean;
}

/** Tokens shorter than this are rejected regardless of configuration. */
export const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;

const LABEL_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Parse MCP_AUTH_TOKEN_HASHES. Throws on any malformed entry so that a typo
 * fails at startup instead of silently locking clients out (or in).
 * Error messages reference entry positions only, never their contents.
 */
export function parseTokenHashes(raw: string | undefined): TokenEntry[] {
  if (!raw || raw.trim() === "") return [];

  const entries: TokenEntry[] = [];
  const labels = new Set<string>();
  const hashes = new Set<string>();
  const parts = raw.split(/[\s,]+/).filter((p) => p !== "");

  parts.forEach((part, i) => {
    const position = `entry ${i + 1}`;
    const fields = part.split(":");
    if (fields.length < 2 || fields.length > 3) {
      throw new Error(
        `MCP_AUTH_TOKEN_HASHES ${position}: expected label:sha256hex[:ro|rw]`,
      );
    }
    const [label, hashHex, access = "ro"] = fields;
    if (!LABEL_PATTERN.test(label)) {
      throw new Error(
        `MCP_AUTH_TOKEN_HASHES ${position}: label must match ${LABEL_PATTERN}`,
      );
    }
    const hex = hashHex.toLowerCase();
    if (!HASH_PATTERN.test(hex)) {
      throw new Error(
        `MCP_AUTH_TOKEN_HASHES ${position}: hash must be 64 hex characters (SHA-256)`,
      );
    }
    if (access !== "ro" && access !== "rw") {
      throw new Error(
        `MCP_AUTH_TOKEN_HASHES ${position}: access must be "ro" or "rw"`,
      );
    }
    if (labels.has(label)) {
      throw new Error(`MCP_AUTH_TOKEN_HASHES ${position}: duplicate label`);
    }
    if (hashes.has(hex)) {
      throw new Error(`MCP_AUTH_TOKEN_HASHES ${position}: duplicate hash`);
    }
    labels.add(label);
    hashes.add(hex);
    entries.push({
      label,
      hash: Buffer.from(hex, "hex"),
      canWrite: access === "rw",
    });
  });

  return entries;
}

/**
 * All Authorization header values exactly as received, in order.
 *
 * Node keeps only the first value of a repeated Authorization header in
 * `req.headers`, so duplicates must be detected from `req.rawHeaders`
 * (a flat [name, value, name, value, ...] list with original casing).
 */
export function authorizationHeaderValues(rawHeaders: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === "authorization") values.push(rawHeaders[i + 1]);
  }
  return values;
}

/**
 * Extract a bearer token from an Authorization header value.
 * Returns null for missing, repeated, malformed, or out-of-range tokens.
 */
export function extractBearerToken(
  header: string | string[] | undefined,
): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header);
  if (!match) return null;
  const token = match[1];
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  return token;
}

/**
 * Resolve the Authorization header to a configured token entry, or null.
 * Every configured hash is compared so timing does not reveal which entry
 * (if any) matched.
 */
export function authenticate(
  header: string | string[] | undefined,
  entries: readonly TokenEntry[],
): TokenEntry | null {
  const token = extractBearerToken(header);
  if (token === null) return null;

  const presented = hashToken(token);
  let matched: TokenEntry | null = null;
  for (const entry of entries) {
    if (timingSafeEqual(presented, entry.hash) && matched === null) {
      matched = entry;
    }
  }
  return matched;
}
