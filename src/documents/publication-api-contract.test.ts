import { describe, expect, it } from "vitest";
import {
  isDecidePublicationRequest,
  isFreezePublicationRequest,
} from "@/documents/publication-api-contract";

const operationId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const uploadId = "33333333-3333-4333-8333-333333333333";

describe("publication API contract", () => {
  it("accepts only normalized freeze requests without server paths", () => {
    const valid = {
      operationId,
      clientRequestId: "freeze-request-1",
      turnId,
      uploadId,
      targetRelativePath: "knowledge/report.docx",
    };
    expect(isFreezePublicationRequest(valid)).toBe(true);
    expect(isFreezePublicationRequest({ ...valid, targetRelativePath: "../report.docx" })).toBe(false);
    expect(isFreezePublicationRequest({ ...valid, publishWriteRoot: "/private/official" })).toBe(false);
  });

  it("requires an exact confirm or decline contract", () => {
    const valid = {
      action: "confirm",
      clientRequestId: "confirm-request-1",
      turnId,
      confirmationToken: "v1.token",
    };
    expect(isDecidePublicationRequest(valid)).toBe(true);
    expect(isDecidePublicationRequest({ ...valid, action: "publish" })).toBe(false);
    expect(isDecidePublicationRequest({ ...valid, confirmationToken: "bad\nsecret" })).toBe(false);
  });
});
