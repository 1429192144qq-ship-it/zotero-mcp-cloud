# Persistent private Zotero access

This branch is not deployed. Keep the existing Railway service, Zotero library and server-side `ZOTERO_API_KEY`. Never send the Zotero key to AI clients. Static hashed client tokens remain supported and mandatory unless the optional OAuth verifier is fully configured. OAuth access is always read-only.

## Existing service and clients

Endpoint: use your existing private service's HTTPS `/mcp` URL. No production URL or library identifiers are included in this document.

- Claude: configure the existing remote connector at account level with a private client Bearer header, or use the existing Auth0 tenant once OAuth is enabled. Account connector credentials must be retained by Claude. Desktop stdio bridges depending on this PC do not meet the power-off requirement.
- Codex Cloud: register the remote HTTP MCP server in a published cloud environment. `bearer_token_env_var = "ZOTERO_MCP_TOKEN"` references a personal/environment secret, not a value in Git. Verify that both the MCP registration and secret are available to a fresh cloud session. A local Windows environment variable or credential manager record is not a cloud secret.
- ChatGPT: OAuth Authorization Code with PKCE and refresh tokens using the existing Auth0 tenant. Do not paste a Zotero key into connector configuration. Discovery is served at `/.well-known/oauth-protected-resource/mcp` (and the root alias). A missing/invalid token receives a 401 challenge with `resource_metadata`. No library data is public.

## Optional Auth0 resource-server configuration

Configure only after reviewing and authorizing deployment. No tenant, paid feature, identity provider or storage system is created by this branch.

| Variable | Meaning |
| --- | --- |
| MCP_OAUTH_ISSUER | Existing Auth0 HTTPS issuer URL, trailing slash |
| MCP_OAUTH_AUDIENCE | Existing Auth0 API identifier; use the MCP resource URL when configuring an API |
| MCP_OAUTH_RESOURCE | Public HTTPS MCP endpoint URL |
| MCP_OAUTH_SUBJECTS | Explicit comma-separated authorized owner subject IDs; no unrestricted tenant access |

RS256 signature, issuer, audience, expiry, issued-at, owner subject and `zotero:read` scope are required. JWKS is fetched only from the configured issuer, never a token-supplied URL. Refreshed access tokens retain session ownership based on issuer, subject and OAuth client ID. Access tokens are not passed to Zotero. Do not put Auth0 client secrets or refresh tokens in source/environment examples. Existing static Bearer authentication remains available independently.

In the existing Auth0 application/API, verify Authorization Code + PKCE, refresh-token grant/rotation, `offline_access`, `zotero:read`, and exact callback URLs provided by each client's live connection UI. Enable Allow Offline Access only if available in the current plan. Register each client using that client's supported flow; this server does not implement dynamic registration or issue/refresh OAuth tokens. Auth0 and the client perform refresh. If the client requires unsupported registration, report a compatibility blocker; do not disable authentication or buy features automatically.

## Actual PDF tool

`read_pdf(attachmentKey,startPage=1,maxPages=5)` downloads actual cloud bytes, parses PDF objects and returns paginated text, size, SHA-256 and `needsOcr`. It does not return base64 or persist PDFs. Limits: 64 MiB, 20 pages and 120,000 characters per call. Empty extracted text requires OCR; it does not prove the PDF is empty. Use `search_items` then `get_item_attachments` to resolve attachment keys. Canonical number tags are `文献番号: NNN`; unresolved mappings require diagnostic review, never renumbering.

Remote download redirects are manual, at most five, HTTPS and trusted storage hosts only. Only the original official API request carries the Zotero key. No redirect receives it. Network errors and an incomplete body remain unconfirmed. Raw response bodies and transport exceptions are suppressed in client errors.

## Required acceptance checklist (not yet passed on live clients)

For each of Claude, Codex Cloud and ChatGPT:

1. Search for a previously verified private sample by title or canonical tag and resolve its attachment; confirm the title and permanent ID privately.
2. Call `read_pdf` and compare real paper text, size and SHA-256 with the privately retained audit evidence. Do not substitute metadata/fulltext HTTP success for PDF bytes.
3. Close the conversation; open an independent new conversation using the same published connector/environment. Repeat without pasting a key/token.
4. Test with this PC off. For OAuth, repeat after access-token expiry; the client refreshes without a new login unless revoked/expired.
5. Confirm a request with no token, wrong owner, missing scope, wrong audience or expired token is rejected.

The local parser smoke test used an existing private PDF without another cloud download. Unit tests do not establish any real AI account's authorization or new-chat persistence. Keep sample keys, paper contents, fingerprints and local paths outside this repository.

## Current OAuth interoperability status

This implements a resource server, not an end-to-end Auth0 login or token-renewal service. The real tenant's issuer/discovery, PKCE metadata, client registration, callback allowlist, resource-to-audience mapping, grants and account consent have not been validated. No live client login, refresh or new-conversation persistence has passed.

Before deployment, confirm the selected client's supported registration path and copy its exact callback from its management UI. Do not assume a fixed historical ChatGPT callback. Validate the real authorization-code exchange and an actual refresh after expiry. Auth0 may issue a userinfo-audience token when receiving only an MCP `resource` parameter; our verifier must continue rejecting that token. Resolve the tenant's documented audience mapping without weakening audience checks or changing tenant-wide defaults automatically.

Sources checked for interoperability (not proof of tenant configuration): [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [Auth0 audience compatibility](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0), [Auth0 refresh tokens](https://auth0.com/docs/secure/tokens/refresh-tokens/get-refresh-tokens), [Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp).

## Deployment risks

Existing fixed-token clients continue through the original SHA-256 verifier; no existing token or token hash needs rotation for this code change. OAuth environment variables are optional; partially configured OAuth fails startup closed. Keep them absent when rolling out only the static-token/PDF fixes. OAuth requires approved existing-tenant configuration and external JWKS availability.

Node >=22.13.0 is now required by PDF.js. The existing Docker/CI Node 22 images meet the version family requirement; run the real container checks before release. PDF byte and output limits do not cap parser CPU or total concurrent memory: load-test private PDFs and Railway memory limits before enabling production use. Downloads are limited to trusted HTTPS redirect hosts and 64 MiB; unusual attachment backends or larger files may require separately reviewed support. Error text is intentionally sanitized. No deployment, tenant changes or production-secret changes are part of this branch.
