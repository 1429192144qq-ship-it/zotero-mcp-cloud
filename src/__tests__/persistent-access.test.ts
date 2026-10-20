import { describe,it,expect,vi,afterEach } from "vitest";
import { generateKeyPair,SignJWT,createLocalJWKSet,exportJWK } from "jose";
import { createOAuthVerifier,oauthFromEnv,protectedResource } from "../oauth.js";
import { ZoteroClient } from "../zotero-api.js";
import { readPdf } from "../pdf-reader.js";
import { createHttpServer } from "../http.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { once } from "node:events";

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe("persistent OAuth identity",()=>{
  const config={issuer:"https://issuer.example/",audience:"https://mcp.example/mcp",resource:"https://mcp.example/mcp",subjects:["auth0|owner"],scope:"zotero:read"};
  it("fails closed on partial configuration and publishes the protected resource",()=>{
    expect(()=>oauthFromEnv({MCP_OAUTH_ISSUER:config.issuer})).toThrow();
    expect(protectedResource(config).authorization_servers).toEqual([config.issuer]);
  });
  it("validates signature, issuer, audience, subject, scope and expiry; refresh preserves session identity",async()=>{
    const {publicKey,privateKey}=await generateKeyPair("RS256");
    const jwk=await exportJWK(publicKey);jwk.kid="test";
    const verify=createOAuthVerifier(config,createLocalJWKSet({keys:[jwk]}));
    const sign=(claims:Record<string,unknown>={})=>new SignJWT({scope:"zotero:read",azp:"chatgpt",...claims}).setProtectedHeader({alg:"RS256",kid:"test"}).setIssuer(config.issuer).setAudience(config.audience).setSubject("auth0|owner").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const first=await verify("Bearer "+await sign());
    const refreshed=await verify("Bearer "+await sign({jti:"rotated"}));
    expect(first?.canWrite).toBe(false);expect(refreshed?.label).toBe(first?.label);
    expect(await verify("Bearer "+await sign({scope:"other"}))).toBeNull();
    const bad=await new SignJWT({scope:"zotero:read"}).setProtectedHeader({alg:"RS256",kid:"test"}).setIssuer(config.issuer).setAudience("wrong").setSubject("auth0|owner").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    expect(await verify("Bearer "+bad)).toBeNull();
    for (const [issuer,subject,expiry] of [["https://wrong.example/","auth0|owner","5m"],[config.issuer,"auth0|other","5m"],[config.issuer,"auth0|owner","-1h"]]) {
      const invalid=await new SignJWT({scope:"zotero:read"}).setProtectedHeader({alg:"RS256",kid:"test"}).setIssuer(issuer).setAudience(config.audience).setSubject(subject).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
      expect(await verify("Bearer "+invalid)).toBeNull();
    }
    expect(await verify(["Bearer invalid","Bearer invalid"])).toBeNull();
    expect(await verify("Bearer invalid")).toBeNull();
    expect(await verify("Bearer "+await sign({azp:undefined}))).toBeNull();
    expect((await verify("Bearer "+await sign({azp:"another-client"})))?.label).not.toBe(first?.label);
  });
  it("advertises OAuth metadata without exposing the library or opening MCP",async()=>{
    const server=createHttpServer({tokens:[],oauth:config,createMcpServer:()=>new McpServer({name:"test",version:"1"}),log:()=>{}});
    server.listen(0,"127.0.0.1");await once(server,"listening");
    try {
      const address=server.address(); if (!address || typeof address==="string") throw Error("address");
      const base=`http://127.0.0.1:${address.port}`;
      const metadata=await fetch(base+"/.well-known/oauth-protected-resource/mcp");
      expect(metadata.status).toBe(200);expect((await metadata.json()).resource).toBe(config.resource);
      const denied=await fetch(base+"/mcp");expect(denied.status).toBe(401);expect(denied.headers.get("www-authenticate")).toContain("resource_metadata=");
    } finally {await new Promise<void>((resolve)=>server.close(()=>resolve()));}
  });
});
describe("cloud file credential isolation",()=>{
  it("never forwards API credential to signed storage redirects",async()=>{
    vi.useFakeTimers({shouldAdvanceTime:true});
    const mock=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:"https://zoterofilestorage.s3.us-east-1.amazonaws.com/file?signature=example"}})).mockResolvedValueOnce(new Response("%PDF-test"));
    vi.stubGlobal("fetch",mock);
    const client=new ZoteroClient({apiKey:"test-secret-not-real",libraryId:"1"});
    await client.downloadAttachment("TEST1234");
    expect(mock.mock.calls[0][1].headers["Zotero-API-Key"]).toBe("test-secret-not-real");
    expect(mock.mock.calls[1][1].headers["Zotero-API-Key"]).toBeUndefined();
    expect(mock.mock.calls.every(c=>c[1].redirect==="manual")).toBe(true);
  });
  it("blocks insecure/unapproved redirect and omits response body from error",async()=>{
    const mock=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location:"https://evil.example/file"}}));vi.stubGlobal("fetch",mock);
    const client=new ZoteroClient({apiKey:"test-secret",libraryId:"1"});
    await expect(client.downloadAttachment("TEST1234")).rejects.toThrow("credential boundary");expect(mock).toHaveBeenCalledTimes(1);
    mock.mockResolvedValue(new Response("sensitive body",{status:403}));
    await expect(new ZoteroClient({apiKey:"test-secret",libraryId:"1"}).downloadAttachment("TEST1234")).rejects.not.toThrow("sensitive body");
  });
  it("rejects non-PDF rather than claiming readable cloud content",async()=>{
    await expect(readPdf(Buffer.from("HTTP 200 metadata is not a PDF"))).rejects.toThrow();
  });
  it("parses actual PDF objects into bounded page text with fingerprint",async()=>{
    const stream="BT /F1 12 Tf 40 700 Td (Hello cloud PDF) Tj ET";
    const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let text="%PDF-1.4\n";const offsets=[0];
    objects.forEach((object,index)=>{offsets.push(text.length);text+=`${index+1} 0 obj\n${object}\nendobj\n`;});
    const xref=text.length;text+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o=>o.toString().padStart(10,"0")+" 00000 n ").join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const result=await readPdf(Buffer.from(text));expect(result.pages[0].text).toContain("Hello cloud PDF");expect(result.sha256).toHaveLength(64);expect(result.needsOcr).toBe(false);
  });
});
