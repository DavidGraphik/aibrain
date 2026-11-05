import { describe, expect, it } from "vitest";
import {
  isCreateExplicitMemoryRequest,
  isConfirmMemoryProposalRequest,
  isDeleteGovernedMemoryRequest,
  isRejectMemoryProposalRequest,
  isRestoreGovernedMemoryRequest,
  isRevokeExplicitMemoryRequest,
  isUpdateGovernedMemoryRequest,
  parseMemoryListQuery,
} from "@/memory/http-contract";

const CLIENT_REQUEST_ID = "00000000-0000-4000-8000-000000000001";

describe("memory HTTP contract", () => {
  it("accepts only explicit, bounded and idempotent manual memory writes", () => {
    const valid = {
      explicit: true,
      kind: "decision",
      content: "Use the approved handoff.",
      sourceExcerpt: "Please remember that we use the approved handoff.",
      clientRequestId: CLIENT_REQUEST_ID,
    };
    expect(isCreateExplicitMemoryRequest(valid)).toBe(true);
    expect(isCreateExplicitMemoryRequest({ ...valid, explicit: false })).toBe(false);
    expect(isCreateExplicitMemoryRequest({ ...valid, unknown: true })).toBe(false);
    expect(isCreateExplicitMemoryRequest({ ...valid, clientRequestId: "retry" })).toBe(false);
    expect(isCreateExplicitMemoryRequest({ ...valid, content: "x".repeat(32_001) })).toBe(false);
  });

  it("accepts only explicit revocation requests", () => {
    const valid = {
      explicit: true,
      reason: "This decision was replaced.",
      clientRequestId: CLIENT_REQUEST_ID,
    };
    expect(isRevokeExplicitMemoryRequest(valid)).toBe(true);
    expect(isRevokeExplicitMemoryRequest({ ...valid, explicit: false })).toBe(false);
    expect(isRevokeExplicitMemoryRequest({ ...valid, reason: "" })).toBe(false);
  });

  it("parses a bounded list query and rejects ambiguity", () => {
    expect(parseMemoryListQuery(new URLSearchParams())).toEqual({ status: "active", limit: 50 });
    expect(parseMemoryListQuery(new URLSearchParams("status=all&kind=decision&limit=100")))
      .toEqual({ status: "all", kind: "decision", limit: 100 });
    expect(parseMemoryListQuery(new URLSearchParams("status=active&status=revoked"))).toBeNull();
    expect(parseMemoryListQuery(new URLSearchParams("limit=101"))).toBeNull();
    expect(parseMemoryListQuery(new URLSearchParams("unknown=1"))).toBeNull();
  });

  it("requires explicit scoped confirmation, rejection, edit, deletion and restoration", () => {
    expect(isConfirmMemoryProposalRequest({ explicit: true, projectId: CLIENT_REQUEST_ID, content: "Confirmado", scope: "project" })).toBe(true);
    expect(isConfirmMemoryProposalRequest({ explicit: false, projectId: CLIENT_REQUEST_ID, content: "Confirmado", scope: "project" })).toBe(false);
    expect(isRejectMemoryProposalRequest({ explicit: true, projectId: CLIENT_REQUEST_ID, reason: "No guardar" })).toBe(true);
    expect(isUpdateGovernedMemoryRequest({ explicit: true, projectId: CLIENT_REQUEST_ID, expectedRevision: 2, content: "Editada" })).toBe(true);
    expect(isDeleteGovernedMemoryRequest({ explicit: true, projectId: CLIENT_REQUEST_ID, expectedRevision: 2 })).toBe(true);
    expect(isDeleteGovernedMemoryRequest({ explicit: true, projectId: CLIENT_REQUEST_ID, expectedRevision: 0 })).toBe(false);
    expect(isRestoreGovernedMemoryRequest({ explicit: true, projectId: CLIENT_REQUEST_ID, expectedRevision: 2 })).toBe(true);
    expect(isRestoreGovernedMemoryRequest({ explicit: false, projectId: CLIENT_REQUEST_ID, expectedRevision: 2 })).toBe(false);
  });
});
