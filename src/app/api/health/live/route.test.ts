import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/live/route";

describe("liveness route", () => {
  afterEach(() => {
    delete process.env.AIBRAIN_REVISION;
  });

  it("exposes only an exact deployed source revision", async () => {
    process.env.AIBRAIN_REVISION = "fdae78a93e2648f16edca127f77285d5d6be5b46";
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      status: "live",
      revision: "fdae78a93e2648f16edca127f77285d5d6be5b46",
    });
  });

  it("does not reflect malformed revision configuration", async () => {
    process.env.AIBRAIN_REVISION = "secret-or-tag";
    const response = await GET();

    await expect(response.json()).resolves.toMatchObject({ revision: null });
  });
});
