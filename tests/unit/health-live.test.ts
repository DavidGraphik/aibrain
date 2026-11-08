import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/live/route";

describe("liveness healthcheck", () => {
  it("returns a non-cacheable, content-free liveness payload", async () => {
    const response = await GET();
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      schemaVersion: 1,
      status: "live",
      processStartedAt: expect.any(String),
      checkedAt: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|token|cookie|prompt/i);
  });
});
