import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { TokenEntry } from "./auth.js";

export interface OAuthOptions { issuer:string; audience:string; resource:string; subjects:readonly string[]; scope:string }
export function oauthFromEnv(env:NodeJS.ProcessEnv):OAuthOptions|undefined {
  const names=["MCP_OAUTH_ISSUER","MCP_OAUTH_AUDIENCE","MCP_OAUTH_RESOURCE","MCP_OAUTH_SUBJECTS"];
  if (!names.some(n=>env[n])) return undefined;
  if (!names.every(n=>env[n])) throw new Error("Incomplete OAuth configuration");
  const issuer=new URL(env.MCP_OAUTH_ISSUER!); const resource=new URL(env.MCP_OAUTH_RESOURCE!);
  if (issuer.protocol!=="https:" || resource.protocol!=="https:" || issuer.username || resource.username || issuer.password || resource.password || issuer.search || issuer.hash || resource.search || resource.hash)
    throw new Error("OAuth requires HTTPS issuer and resource without credentials/query");
  const subjects=env.MCP_OAUTH_SUBJECTS!.split(",").map(s=>s.trim()).filter(Boolean);
  if (!subjects.length) throw new Error("OAuth subject allowlist required");
  return {issuer:issuer.href.endsWith("/")?issuer.href:issuer.href+"/",audience:env.MCP_OAUTH_AUDIENCE!,resource:resource.href,subjects,scope:"zotero:read"};
}
export function protectedResource(config:OAuthOptions) {
  return {resource:config.resource,authorization_servers:[config.issuer],scopes_supported:[config.scope,"offline_access"],bearer_methods_supported:["header"]};
}
export function createOAuthVerifier(config:OAuthOptions, suppliedKey?:JWTVerifyGetKey) {
  const key=suppliedKey??createRemoteJWKSet(new URL(".well-known/jwks.json",config.issuer),{timeoutDuration:10_000});
  return async (header:string|string[]|undefined):Promise<TokenEntry|null> => {
    if (typeof header!=="string") return null;
    const match=/^Bearer ([^\s]{1,16384})$/.exec(header); if (!match) return null;
    try {
      const {payload}=await jwtVerify(match[1],key,{issuer:config.issuer,audience:config.audience,algorithms:["RS256"],requiredClaims:["exp","sub","iat"]});
      if (!payload.sub || !config.subjects.includes(payload.sub) || typeof payload.scope!=="string" || !payload.scope.split(" ").includes(config.scope)) return null;
      // Stable across token refresh, isolated between OAuth clients and human subjects.
      const clientId=payload.azp??payload.client_id;
      if (typeof clientId!=="string" || !clientId.trim()) return null;
      const hash=createHash("sha256").update(JSON.stringify([config.issuer,payload.sub,clientId])).digest();
      return {label:"oauth-"+hash.toString("hex"),hash,canWrite:false};
    } catch { return null; }
  };
}
