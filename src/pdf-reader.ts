import { createHash } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function readPdf(bytes: Buffer, startPage = 1, maxPages = 5) {
  if (bytes.length > 64 * 1024 * 1024 || !bytes.subarray(0,1024).includes(Buffer.from("%PDF-"))) throw new Error("Invalid PDF format/size");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const task = getDocument({data:Uint8Array.from(bytes),useSystemFonts:false,disableFontFace:true,verbosity:0});
  try {
    const doc = await task.promise;
    if (startPage > doc.numPages) throw new Error("Page outside document");
    const pages: {page:number;text:string}[] = []; let remaining = 120_000; let truncated = false;
    for (let n=startPage;n<=Math.min(doc.numPages,startPage+maxPages-1);n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map(i => "str" in i ? i.str : "").join(" ");
      pages.push({page:n,text:text.slice(0,remaining)});
      if (text.length > remaining) truncated=true;
      remaining -= Math.min(remaining,text.length); page.cleanup();
      if (remaining===0) break;
    }
    return {sizeBytes:bytes.length,sha256,totalPages:doc.numPages,pages,truncated,needsOcr:pages.every(p=>!p.text.trim())};
  } finally { await task.destroy(); }
}
