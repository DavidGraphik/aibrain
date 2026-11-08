// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { MailConnectionCard } from "@/components/mail-connection-card";
import { UiLocaleProvider } from "@/i18n/provider";
import type { PersonalConnectorSettings } from "@/settings/connector-settings";

const connector: PersonalConnectorSettings = {
  id: "mail", label: "Correo Nominalia", status: "requires_login", statusCode: "MAIL_LOGIN_REQUIRED",
  statusDetail: "Conecta tu buzón con la contraseña de tu correo.", accountEmail: "person@example.test",
  scopes: ["mail.read", "mail.write", "mail.send"], connectUrl: "/api/connectors/mail/connect",
  disconnectUrl: null, connectionVersion: null, connectionMethod: "password",
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Nominalia self-service connection", () => {
  it("submits only the mailbox password, clears it immediately and refreshes verified settings", async () => {
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const changed = vi.fn();
    render(<MailConnectionCard connector={connector} accountEmail="person@example.test" onChanged={changed} />);
    const input = screen.getByLabelText("Contraseña de tu correo");
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByText("person@example.test")).toBeInTheDocument();
    expect(screen.getByText(/correos descargados y eliminados por Outlook/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "synthetic-mail-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Correo Nominalia" }));
    expect(input).toHaveValue("");
    expect(input).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/connectors/mail/connect", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "synthetic-mail-password" }),
    });
    complete(Response.json({ connected: true }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent("Buzón conectado. Ya puedes leer, organizar, redactar y enviar correos desde el chat.");
  });

  it("shows a useful failure without rendering provider errors or passwords", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "synthetic-mail-password: provider diagnostic" }, { status: 422 })));
    const changed = vi.fn();
    render(<MailConnectionCard connector={connector} accountEmail="person@example.test" onChanged={changed} />);
    fireEvent.change(screen.getByLabelText("Contraseña de tu correo"), { target: { value: "synthetic-mail-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Correo Nominalia" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Comprueba la contraseña de tu correo");
    expect(document.body.textContent).not.toContain("synthetic-mail-password");
    expect(screen.getByLabelText("Contraseña de tu correo")).toHaveValue("");
    expect(changed).not.toHaveBeenCalled();
  });

  it("reconnects in place and disconnects without navigation", async () => {
    const fetchMock = vi.fn(async () => Response.json({ disconnected: true }));
    vi.stubGlobal("fetch", fetchMock);
    const changed = vi.fn();
    render(<MailConnectionCard connector={{ ...connector, status: "connected", disconnectUrl: "/api/connectors/mail/disconnect" }} accountEmail="person@example.test" onChanged={changed} />);
    expect(screen.queryByLabelText("Contraseña de tu correo")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar contraseña" }));
    fireEvent.change(screen.getByLabelText("Contraseña de tu correo"), { target: { value: "discard-me" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: "Actualizar contraseña" }));
    expect(screen.getByLabelText("Contraseña de tu correo")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Desconectar Correo Nominalia" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/connectors/mail/disconnect", { method: "POST" });
  });

  it.each(["es", "en"] as const)("explains ordinary chat requests in %s", locale => {
    render(<UiLocaleProvider locale={locale}><MailConnectionCard connector={{ ...connector, status: "connected", disconnectUrl: "/api/connectors/mail/disconnect" }} accountEmail="person@example.test" onChanged={vi.fn()} /></UiLocaleProvider>);
    expect(screen.getByText(locale === "es"
      ? "Lee, organiza, redacta y envía correos de Nominalia desde la conversación."
      : "Read, organize, draft and send Nominalia emails in the conversation.")).toBeInTheDocument();
    expect(screen.getByText(locale === "es"
      ? "Pide en el chat lo que necesites hacer con tu correo."
      : "Ask in chat for whatever you need to do with your email.")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByLabelText(locale === "es" ? "Contraseña de tu correo" : "Email password")).not.toBeInTheDocument();
  });
});
