import { describe, expect, it, vi } from "vitest";
import { instantlyRead } from "@/connectors/instantly-api";
const workspace = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
function provider(values: unknown[]) { const f = vi.fn(); for (const v of values) f.mockResolvedValueOnce(Response.json(v)); return f; }
describe("Instantly bounded read-only adapter", () => {
  it("checks the authenticated workspace before reading any data", async () => {
    const f = provider([{ id: foreign }]);
    await expect(instantlyRead(f, "private-key", workspace, "accounts")).rejects.toMatchObject({ code: "INSTANTLY_WORKSPACE_MISMATCH" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("does not expose account credentials or unreviewed fields", async () => {
    const f = provider([{ id: workspace }, { items: [{ organization: workspace, email: "test@acme.test", status: 1, smtp_password: "private-password", token: "private-token", warmup: { password: "bad" } }], next_starting_after: "cursor" }]);
    const result = await instantlyRead(f, "private-key", workspace, "accounts", { limit: 5 });
    expect(result).toMatchObject({ workspaceId: workspace, nextCursor: "cursor", items: [{ email: "test@acme.test", status: 1 }] });
    expect(JSON.stringify(result)).not.toMatch(/private-key|private-password|private-token|password|token/);
    expect(f.mock.calls.every(([, options]) => options.redirect === "error")).toBe(true);
  });
  it("fails closed on a foreign returned record and on mutation or URL arguments", async () => {
    const f = provider([{ id: workspace }, { items: [{ organization: foreign }] }]);
    await expect(instantlyRead(f, "key", workspace, "leads")).rejects.toMatchObject({ code: "INSTANTLY_WORKSPACE_MISMATCH" });
    const denied = provider([]);
    await expect(instantlyRead(denied, "key", workspace, "activate" as never)).rejects.toMatchObject({ code: "INSTANTLY_ARGUMENTS_INVALID" });
    await expect(instantlyRead(denied, "key", workspace, "accounts", { url: "https://foreign.test" })).rejects.toMatchObject({ code: "INSTANTLY_ARGUMENTS_INVALID" });
    expect(denied).not.toHaveBeenCalled();
  });
  it("restricts warmup analytics to owned accounts without changing warmup", async () => {
    const f = provider([{ id: workspace }, { items: [{ organization: workspace, email: "own@acme.test" }] }]);
    await expect(instantlyRead(f, "key", workspace, "warmup", { emails: ["foreign@else.test"] })).rejects.toMatchObject({ code: "INSTANTLY_ACCOUNT_DENIED" });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("returns empty replies and numeric metrics honestly", async () => {
    const f = provider([{ id: workspace }, { items: [] }]);
    expect(await instantlyRead(f, "key", workspace, "replies")).toMatchObject({ items: [] });
    expect(f.mock.calls[1][0]).toContain("email_type=received");
    const metrics = provider([{ id: workspace }, { reply_count: 0, emails_sent_count: 0, token: "hidden" }]);
    expect(await instantlyRead(metrics, "key", workspace, "metrics")).toMatchObject({ metrics: { reply_count: 0, emails_sent_count: 0 } });
  });
  it("redacts provider errors and never retries uncertain requests", async () => {
    const f = vi.fn().mockResolvedValue(new Response("secret error", { status: 401 }));
    await expect(instantlyRead(f, "key", workspace, "workspace")).rejects.toMatchObject({ code: "INSTANTLY_HTTP_401" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("reads campaign copy only after exact organization and campaign ownership", async () => {
    const f = provider([{ id: workspace }, { id: foreign, organization: workspace, name: 'Selected', email_list: ['sender@acme.test'], smtp_password: 'private', sequences: [{ steps: [{ type: 'email', delay: 7, delay_unit: 'days', variants: [{ subject: 'Hello', body: '<p>Body</p>', secret: 'private' }] }] }] }]);
    const result = await instantlyRead(f, 'key', workspace, 'campaign', { campaignId: foreign });
    expect(result).toMatchObject({ campaign: { id: foreign, name: 'Selected' }, sendingAccounts: ['sender@acme.test'], sequences: [{ steps: [{ delay: 7, delayUnit: 'days', variants: [{ subject: 'Hello', body: '<p>Body</p>' }] }] }] });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(f.mock.calls[1][0]).toBe(`https://api.instantly.ai/api/v2/campaigns/${foreign}`);
    const denied = provider([{ id: workspace }, { id: foreign, organization: foreign }]);
    await expect(instantlyRead(denied, 'key', workspace, 'leads', { campaignId: foreign })).rejects.toMatchObject({ code: 'INSTANTLY_WORKSPACE_MISMATCH' });
    expect(denied).toHaveBeenCalledTimes(2);
  });
  it.each(['leads', 'replies'] as const)('rejects misfiltered %s in an owned campaign', async operation => {
    const f = provider([{ id: workspace }, { id: foreign, organization: workspace }, { items: [{ organization: workspace, organization_id: workspace, campaign: workspace, campaign_id: workspace, email: 'secret@acme.test' }] }]);
    await expect(instantlyRead(f, 'key', workspace, operation, { campaignId: foreign })).rejects.toMatchObject({ code: 'INSTANTLY_CAMPAIGN_MISMATCH' });
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('bounds campaign payloads and rejects malformed selected IDs before network', async () => {
    const f = provider([]);
    await expect(instantlyRead(f, 'key', workspace, 'campaign', { campaignId: 'https://elsewhere.test' })).rejects.toMatchObject({ code: 'INSTANTLY_ARGUMENTS_INVALID' });
    expect(f).not.toHaveBeenCalled();
    const many = provider([{ id: workspace }, { items: Array.from({ length: 3 }, () => ({ organization: workspace })) }]);
    await expect(instantlyRead(many, 'key', workspace, 'campaigns', { limit: 2 })).rejects.toMatchObject({ code: 'INSTANTLY_RESPONSE_INVALID' });
  });
  it('binds selected campaign analytics and rejects a mismatched campaign detail', async () => {
    const f = provider([{ id: workspace }, { id: foreign, organization: workspace }, { emails_sent_count: 7 }]);
    expect(await instantlyRead(f, 'key', workspace, 'metrics', { campaignId: foreign })).toMatchObject({ metrics: { emails_sent_count: 7 } });
    expect(f.mock.calls[2][0]).toContain(`id=${foreign}`);
    const denied = provider([{ id: workspace }, { id: workspace, organization: workspace }]);
    await expect(instantlyRead(denied, 'key', workspace, 'metrics', { campaignId: foreign })).rejects.toMatchObject({ code: 'INSTANTLY_CAMPAIGN_MISMATCH' });
    expect(denied).toHaveBeenCalledTimes(2);
  });
});
