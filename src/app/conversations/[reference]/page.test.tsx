import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Page from "./page";
import { WorkbenchNotFoundError } from "@/workbench/errors";
const mock = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: mock.session }));
vi.mock("@/workbench/conversation-reference", () => ({ readConversationReference: mock.read }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock("@/components/markdown-message", () => ({ MarkdownMessage: ({ children }: { children: string }) => <div>{children}</div> }));
beforeEach(() => {
  vi.clearAllMocks(); mock.session.mockResolvedValue({ user: { id: "own" } });
  mock.read.mockResolvedValue({ title: "Revisión del 23/10 <script>", status: "archived", messages: [{ id: "message", role: "user", createdAt: "2026-10-23T12:00:00Z", content: "Contenido original del usuario", attachments: [] }] });
});
it("opens an authenticated read-only source with original title/content/date and return navigation", async () => {
  const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ reference: "issued" }) }));
  expect(mock.read).toHaveBeenCalledWith({ user: { id: "own" } }, "issued");
  expect(html).toContain("Contenido original del usuario"); expect(html).toContain("2026-10-23T12:00:00Z");
  expect(html).toContain("solo lectura"); expect(html).toContain("archivada"); expect(html).toContain('href="/"');
  expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
});
it("requires authentication and reveals no inaccessible or revoked source", async () => {
  mock.session.mockResolvedValue(null);
  await expect(Page({ params: Promise.resolve({ reference: "issued" }) })).rejects.toThrow("REDIRECT:/login");
  expect(mock.read).not.toHaveBeenCalled();
  mock.session.mockResolvedValue({ user: { id: "other" } }); mock.read.mockRejectedValue(new WorkbenchNotFoundError("private title"));
  await expect(Page({ params: Promise.resolve({ reference: "issued" }) })).rejects.toThrow("NOT_FOUND");
});
