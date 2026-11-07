import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { publicationDecisionError } from "@/documents/publication-http";
import {
  PublicationStorageBackpressureError,
  PublicationStorageCapacityUnavailableError,
} from "@/documents/publication-capacity";

describe("publication capacity HTTP contract", () => {
  it("returns bounded retry metadata for low capacity without exposing filesystem values", async () => {
    const response = publicationDecisionError(
      new PublicationStorageBackpressureError(5_001, 100n, 200n),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("6");
    const serialized = JSON.stringify(await response.json());
    expect(JSON.parse(serialized)).toMatchObject({
      code: "PUBLICATION_STORAGE_BACKPRESSURE",
      retryable: true,
    });
    expect(serialized).not.toContain("100");
    expect(serialized).not.toContain("200");
  });

  it("returns retryable 503 when the official volume cannot be measured", async () => {
    const response = publicationDecisionError(new PublicationStorageCapacityUnavailableError());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "PUBLICATION_STORAGE_CAPACITY_UNAVAILABLE",
      retryable: true,
    });
  });
});
