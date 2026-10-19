/**
 * Unit tests for static bearer-token authentication (auth.ts).
 * Tokens here are test-only random values, never real credentials.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MIN_TOKEN_LENGTH,
  authenticate,
  authorizationHeaderValues,
  extractBearerToken,
  hashToken,
  parseTokenHashes,
} from "../auth.js";

const tokenA = randomBytes(32).toString("base64url");
const tokenB = randomBytes(32).toString("base64url");
const hashA = hashToken(tokenA).toString("hex");
const hashB = hashToken(tokenB).toString("hex");

describe("hashToken", () => {
  it("returns the SHA-256 digest of the UTF-8 token", () => {
    expect(hashToken("abc").toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("parseTokenHashes", () => {
  it("returns no entries for empty or missing config", () => {
    expect(parseTokenHashes(undefined)).toEqual([]);
    expect(parseTokenHashes("")).toEqual([]);
    expect(parseTokenHashes("  \n ")).toEqual([]);
  });

  it("parses labelled entries with default read-only access", () => {
    const [entry] = parseTokenHashes(`claude:${hashA}`);
    expect(entry.label).toBe("claude");
    expect(entry.canWrite).toBe(false);
    expect(entry.hash.toString("hex")).toBe(hashA);
  });

  it("parses explicit ro/rw access and comma/whitespace separators", () => {
    const entries = parseTokenHashes(`claude:${hashA}:ro,\n codex:${hashB}:rw`);
    expect(entries.map((e) => [e.label, e.canWrite])).toEqual([
      ["claude", false],
      ["codex", true],
    ]);
  });

  it("accepts upper-case hex", () => {
    const [entry] = parseTokenHashes(`claude:${hashA.toUpperCase()}`);
    expect(entry.hash.toString("hex")).toBe(hashA);
  });

  it.each([
    ["bare hash without label", hashA],
    ["short hash", "claude:abcd"],
    ["non-hex hash", `claude:${"z".repeat(64)}`],
    ["bad access level", `claude:${hashA}:admin`],
    ["bad label", `bad label!:${hashA}`],
    ["too many fields", `claude:${hashA}:ro:extra`],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseTokenHashes(raw)).toThrow(/MCP_AUTH_TOKEN_HASHES entry 1/);
  });

  it("rejects duplicate labels and duplicate hashes", () => {
    expect(() => parseTokenHashes(`a:${hashA},a:${hashB}`)).toThrow(/duplicate label/);
    expect(() => parseTokenHashes(`a:${hashA},b:${hashA}`)).toThrow(/duplicate hash/);
  });

  it("never echoes entry contents in error messages", () => {
    const secretLooking = `claude:${hashA}:admin`;
    try {
      parseTokenHashes(secretLooking);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(hashA);
    }
  });
});

describe("authorizationHeaderValues", () => {
  it("returns every Authorization value regardless of name casing", () => {
    expect(
      authorizationHeaderValues([
        "Host", "example",
        "Authorization", "Bearer first",
        "Accept", "*/*",
        "authorization", "Bearer second",
      ]),
    ).toEqual(["Bearer first", "Bearer second"]);
  });

  it("returns an empty list when the header is absent", () => {
    expect(authorizationHeaderValues(["Host", "example"])).toEqual([]);
  });
});

describe("extractBearerToken", () => {
  it("extracts a bearer token case-insensitively", () => {
    expect(extractBearerToken(`Bearer ${tokenA}`)).toBe(tokenA);
    expect(extractBearerToken(`bearer ${tokenA}`)).toBe(tokenA);
  });

  it.each([
    ["missing header", undefined],
    ["empty header", ""],
    ["basic auth", `Basic ${tokenA}`],
    ["no token", "Bearer "],
    ["token with spaces", `Bearer ${tokenA} extra`],
    ["too short", `Bearer ${"a".repeat(MIN_TOKEN_LENGTH - 1)}`],
    ["too long", `Bearer ${"a".repeat(513)}`],
    ["repeated header", [`Bearer ${tokenA}`, `Bearer ${tokenA}`]],
  ])("returns null for %s", (_name, header) => {
    expect(extractBearerToken(header as string | string[] | undefined)).toBeNull();
  });
});

describe("authenticate", () => {
  const entries = parseTokenHashes(`claude:${hashA}:ro,codex:${hashB}:rw`);

  it("resolves each valid token to its own entry", () => {
    expect(authenticate(`Bearer ${tokenA}`, entries)?.label).toBe("claude");
    expect(authenticate(`Bearer ${tokenB}`, entries)?.label).toBe("codex");
  });

  it("rejects unknown, missing, and malformed credentials", () => {
    const other = randomBytes(32).toString("base64url");
    expect(authenticate(`Bearer ${other}`, entries)).toBeNull();
    expect(authenticate(undefined, entries)).toBeNull();
    expect(authenticate(tokenA, entries)).toBeNull();
  });

  it("does not accept the stored hash itself as a token", () => {
    expect(authenticate(`Bearer ${hashA}`, entries)).toBeNull();
  });

  it("rejects everything when no tokens are configured", () => {
    expect(authenticate(`Bearer ${tokenA}`, [])).toBeNull();
  });
});

describe("scripts/generate-token.mjs", () => {
  it("prints a token whose hash entry authenticates it", () => {
    const out = execFileSync("node", ["scripts/generate-token.mjs", "codex", "ro"], {
      encoding: "utf8",
    });
    const token = /^ {2}([A-Za-z0-9_-]{43})$/m.exec(out)?.[1];
    const entry = /^ {2}(codex:[0-9a-f]{64}:ro)$/m.exec(out)?.[1];
    expect(token).toBeDefined();
    expect(entry).toBeDefined();
    const entries = parseTokenHashes(entry);
    expect(authenticate(`Bearer ${token}`, entries)?.label).toBe("codex");
  });

  it("rejects an invalid access level", () => {
    expect(() =>
      execFileSync("node", ["scripts/generate-token.mjs", "codex", "admin"], {
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
