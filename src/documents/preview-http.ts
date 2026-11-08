function mediaType(fileName: string) {
  if (fileName.endsWith(".pdf")) return "application/pdf";
  if (fileName.endsWith(".png")) return "image/png";
  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) return "image/jpeg";
  if (fileName.endsWith(".gif")) return "image/gif";
  if (fileName.endsWith(".webp")) return "image/webp";
  return "text/plain; charset=utf-8";
}

/** Only for validated preview filenames after authorization and source binding. */
export function documentPreviewResponse(data: Uint8Array, fileName: string) {
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": mediaType(fileName),
      "Content-Disposition": `inline; filename="${fileName}"`,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  });
}
