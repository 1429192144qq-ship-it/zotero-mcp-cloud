#!/usr/bin/env node
// Generate a client access token and its MCP_AUTH_TOKEN_HASHES entry.
//
//   npm run token:generate -- <label> [ro|rw]
//
// Run this on your own machine. Give the token to the client only (Codex env
// var, Claude connector header); put only the hash entry on the server.
// Neither value belongs in Git.

import { createHash, randomBytes } from "node:crypto";

const [label = "client", access = "ro"] = process.argv.slice(2);

if (!/^[A-Za-z0-9_.-]{1,40}$/.test(label)) {
  process.stderr.write("Label must be 1-40 characters of A-Z, a-z, 0-9, _ . -\n");
  process.exit(1);
}
if (access !== "ro" && access !== "rw") {
  process.stderr.write('Access must be "ro" or "rw"\n');
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token, "utf8").digest("hex");

process.stdout.write(
  [
    `Client token (give to "${label}" only; shown once):`,
    `  ${token}`,
    "",
    "Server entry (append to MCP_AUTH_TOKEN_HASHES, comma-separated):",
    `  ${label}:${hash}:${access}`,
    "",
  ].join("\n"),
);
