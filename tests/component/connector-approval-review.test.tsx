// @vitest-environment jsdom
import { render, screen, within } from "../render-spanish";
import { describe, expect, it, vi } from "vitest";
import { PermissionGrant } from "@/components/assistant-ui/elements/permission-grant";
import type { ApprovalItem } from "@/lib/chat-contract";

const base: ApprovalItem = { id: "approval", itemId: "item", threadId: "thread", turnId: "turn", kind: "command", title: "Guardar en Sibema", detail: "", status: "pending", authorizationFingerprint: "a".repeat(64) };
describe("exact business approval review", () => {
  it("shows the entire frozen mail, account and recipients without activity redaction", () => {
    const body = "Inicio\n" + "Contenido extenso. ".repeat(200) + "\n```\n/opt/client/reference\n```\n51388e47-d16c-48f5-b4c8-71827ffc8020\nFin exacto";
    const detail = JSON.stringify({ operation: "mail_draft", input: { type: "create_draft", request: { message: { subject: "Consulta", toRecipients: [{ emailAddress: { address: "qa@example.com" } }], body: { contentType: "Text", content: body } } } }, prepared: { action: { mailbox: "owner@example.com" } } });
    const {container} = render(<PermissionGrant approval={{...base, detail}} onResolve={vi.fn()} />);
    expect(screen.getByText("owner@example.com")).toBeVisible();
    expect(container.querySelector("dl")).toHaveTextContent("qa@example.com");
    expect(Array.from(container.querySelectorAll("dd")).some(e => e.textContent === body)).toBe(true);
    expect(screen.queryByRole("button", {name: "Durante esta tarea"})).toBeNull();
  });
  it("shows the Sibema target and exact new description before approval", () => {
    const detail = JSON.stringify({operation:"sibema_action",input:{type:"update_offer",request:{offerId:102,body:{description:"PRUEBA QA - NO COMERCIAL"}}},prepared:{action:{id:"internal receipt"}}});
    render(<PermissionGrant approval={{...base, detail}} onResolve={vi.fn()} />);
    expect(screen.getByText("102")).toBeVisible();
    expect(screen.getByText("PRUEBA QA - NO COMERCIAL")).toBeVisible();
    expect(screen.queryByText("internal receipt")).toBeNull();
  });
  it("shows the actually composed body and attachment metadata that the provider will save", () => {
    const detail=JSON.stringify({operation:"mail_draft",input:{type:"create_draft",request:{message:{body:{contentType:"Text",content:"Original input"}}}},prepared:{action:{mailbox:"owner@example.com",request:{message:{body:{contentType:"Text",content:"Original input\nVerified signature"},attachments:[{name:"original.pdf",contentBytes:{bytes:20,sha256:"a".repeat(64)}}]}}}}});
    const {container}=render(<PermissionGrant approval={{...base,detail}} onResolve={vi.fn()} />);
    expect(Array.from(container.querySelectorAll("dd")).some(e=>e.textContent==="Original input\nVerified signature")).toBe(true);
    expect(container.querySelector("dl")).toHaveTextContent("original.pdf");
    expect(container.querySelector("dl")).toHaveTextContent("a".repeat(64));
  });
  it("renders HTML as inert complete text and guides ordinary commands through chat without decision buttons", () => {
    const detail=JSON.stringify({operation:"mail_draft",input:{request:{message:{body:{contentType:"HTML",content:"<script>alert('x')</script>"}}}}});
    const resolve=vi.fn();
    const {container,unmount}=render(<PermissionGrant approval={{...base,detail}} onResolve={resolve} />);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert('x')</script>")).toBeVisible();
    unmount();
    const ordinary=render(<PermissionGrant approval={{...base,authorizationFingerprint:undefined,detail:"ordinary command"}} onResolve={resolve} />);
    const review=within(ordinary.container);
    expect(review.getByText("Confirma la acción en el chat")).toBeVisible();
    expect(review.queryByRole("button",{name:"Durante esta tarea"})).toBeNull();
    expect(review.queryByRole("button",{name:"Permitir"})).toBeNull();
    expect(review.queryByRole("button",{name:"Rechazar"})).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
