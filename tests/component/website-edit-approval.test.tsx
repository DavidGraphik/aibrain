// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { PermissionGrant } from "@/components/assistant-ui/elements/permission-grant";
import { isApprovalItem, type ApprovalItem } from "@/lib/chat-contract";
afterEach(cleanup);
const before = '"hero_video":"shopify://files/videos/original.mp4"';
const after = '<script>alert("unsafe")</script>' + "x".repeat(2000) + "END_OF_REVIEW";
const item: ApprovalItem = { id: "review", threadId: "thread", turnId: "turn", itemId: "tool", kind: "command", title: "Change Shopify draft website", detail: "Review the video change", status: "pending", fileReview: { filename: "templates/index.json", changes: [{ before, after }] } };
it("keeps the full escaped legacy change inspectable and directs decisions to chat", () => {
  const onResolve = vi.fn();
  const { container } = render(<PermissionGrant approval={item} connectorApproval onResolve={onResolve} />);
  fireEvent.click(screen.getByText("Revisar cambios de la web"));
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelectorAll("pre")[0].textContent).toBe(before);
  expect(container.querySelectorAll("pre")[1].textContent).toBe(after);
  expect(screen.queryByRole("button", { name: "Durante esta tarea" })).not.toBeInTheDocument();
  expect(screen.getByText("Confirma la acción en el chat")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Permitir" })).not.toBeInTheDocument();
  expect(onResolve).not.toHaveBeenCalled();
});
it("validates the optional review and rejects malformed or excessive wire data", () => {
  expect(isApprovalItem(item)).toBe(true);
  expect(isApprovalItem({ ...item, fileReview: { filename: "templates/index.json", changes: [{ before: 42, after: "x" }] } })).toBe(false);
  expect(isApprovalItem({ ...item, fileReview: { filename: "x", changes: [] } })).toBe(false);
  expect(isApprovalItem({ ...item, fileReview: { filename: "x", changes: [{ before: "x".repeat(32001), after: "" }] } })).toBe(false);
  const { fileReview: _review, ...legacy } = item;
  expect(isApprovalItem(legacy)).toBe(true);
});
