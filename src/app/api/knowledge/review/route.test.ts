import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ session: null as object | null, origin: true, list: vi.fn(), scopes: vi.fn(), review: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: async () => mocks.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: async () => mocks.origin }));
vi.mock("@/knowledge/review-service", async (original) => ({ ...await original<typeof import("@/knowledge/review-service")>(), listKnowledgeReviews: mocks.list, knowledgeReviewScopes: mocks.scopes, reviewKnowledge: mocks.review }));
import { GET, POST } from "./route";
import { KnowledgeReviewError } from "@/knowledge/review-service";
import { assertUiContract, uiContract } from "../../../../../tests/helpers/ui-contract";
const id = "10000000-0000-4000-8000-000000000001";
const input = { projectId: id, scope: "company", scopeId: null, connectionId: "arnall", recordId: id, revision: 1, decision: "confirm" };
const request = (body: unknown) => new Request("https://example.test/api/knowledge/review", { method: "POST", body: JSON.stringify(body) });
describe("knowledge review API", () => {
  beforeEach(() => { mocks.session = { user: { id } }; mocks.origin = true; mocks.list.mockReset(); mocks.review.mockReset(); mocks.scopes.mockReset(); });
  it("requires session and same origin before mutations", async () => {
    mocks.session = null; expect((await POST(request(input))).status).toBe(401);
    mocks.origin = false; expect((await POST(request(input))).status).toBe(403);
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("rejects actor injection and oversized payloads before the service", async () => {
    expect((await POST(request({ ...input, actorId: id }))).status).toBe(400);
    expect((await POST(request({ ...input, text: "x".repeat(70000) }))).status).toBe(400);
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("accepts bounded correction text and rejects replacement sources or missing reasons", async () => {
    const correction = { ...input, decision: "correct", content: "Texto corregido ".repeat(400), reason: "Precisar la interpretación de la cita." };
    const response = uiContract["x-examples"].find((item) => item.schema === "KnowledgeReviewPostResponse" && (item.value as { available?: boolean }).available)!.value;
    mocks.review.mockResolvedValue(response);
    const result = await POST(request(correction));
    expect(result.status).toBe(200);
    assertUiContract("KnowledgeReviewPostResponse", await result.json());
    expect(mocks.review).toHaveBeenCalledWith(mocks.session, correction);
    mocks.review.mockClear();
    expect((await POST(request({ ...correction, reason: " " }))).status).toBe(400);
    expect((await POST(request({ ...correction, citations: [] }))).status).toBe(400);
    expect((await POST(request({ ...correction, content: "x".repeat(8001) }))).status).toBe(400);
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("propagates stale revision and role denial without caching", async () => {
    mocks.review.mockRejectedValue(new KnowledgeReviewError("REVISION_CONFLICT", 409));
    const result = await POST(request(input)); expect(result.status).toBe(409); expect(result.headers.get("cache-control")).toContain("no-store");
    assertUiContract("KnowledgeReviewPostResponse", await result.json());
    mocks.list.mockRejectedValue(new KnowledgeReviewError("REVIEW_ROLE_REQUIRED", 403));
    expect((await GET(new Request(`https://example.test/api/knowledge/review?projectId=${id}&scope=company`))).status).toBe(403);
  });
  it("scopes are resolved through the authenticated service and supplied actor fields are rejected", async () => {
    mocks.scopes.mockResolvedValue({ scopes: [] });
    const result = await GET(new Request(`https://example.test/api/knowledge/review?projectId=${id}`));
    expect(result.status).toBe(200);
    assertUiContract("KnowledgeReviewGetResponse", await result.json());
    expect(mocks.scopes).toHaveBeenCalledWith(mocks.session, id);
    expect((await GET(new Request(`https://example.test/api/knowledge/review?projectId=${id}&actorId=${id}`))).status).toBe(400);
  });
});
