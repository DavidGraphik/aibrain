import { createServer } from "node:http";
import { it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { privateHorariaRequest } from "./private-transport";
it("bounds the internal destination and never follows a redirect", async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(302, { location: "http://example.invalid" }); res.end(); });
  server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${address.port}`;
    const options = { method: "GET", headers: {}, signal: AbortSignal.timeout(5_000) };
    await expect(privateHorariaRequest(base, "http://example.invalid/api/steal", options)).rejects.toThrow("target");
    expect(requests).toBe(0);
    await expect(privateHorariaRequest(base, "/api/session", options)).rejects.toThrow("redirects");
    expect(requests).toBe(1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
