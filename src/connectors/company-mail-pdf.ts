/** Some supplier PDF downloads include serialized HTTP headers before the PDF.
 * Keep the complete original as evidence; expose only the verified PDF body for
 * passive reading. Never accept arbitrary HTML, scripts or an unbounded prefix. */
export function mailInvoiceReadingContents(data: Buffer, mediaType: string): Buffer {
  if (mediaType !== "application/pdf" || data.subarray(0, 5).toString("ascii") === "%PDF-") return data;
  const offset = data.subarray(0, 1024).indexOf(Buffer.from("%PDF-"));
  if (offset < 1) return data;
  if (!data.subarray(0, offset).every(byte => byte === 10 || byte === 13 || byte >= 32 && byte <= 126)) return data;
  const prefix = data.subarray(0, offset).toString("ascii");
  if (!/^[\x20-\x7e\r\n]+$/u.test(prefix)) return data;
  const lines = prefix.split(/\\n|\r?\n/u).filter(Boolean);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const match = /^(date|last-modified|etag|accept-ranges|content-type|content-length): ([^<>\r\n]+)$/iu.exec(line);
    if (!match || headers.has(match[1].toLowerCase())) return data;
    headers.set(match[1].toLowerCase(), match[2]);
  }
  const length = headers.get("content-length");
  const body = data.subarray(offset);
  if (headers.get("content-type")?.toLowerCase() !== "application/pdf" || !length ||
      !/^[1-9]\d{0,8}$/u.test(length) || Number(length) !== body.length ||
      !/^%PDF-[12]\.\d[\r\n]/u.test(body.subarray(0, 12).toString("ascii")) ||
      !body.subarray(-1024).includes(Buffer.from("%%EOF"))) return data;
  return body;
}
