// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "../../tests/render-spanish";
import { afterEach, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { UiLocaleProvider } from "@/i18n/provider";
import { LoginForm } from "./login-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ preference: "system", resolvedTheme: "light", setPreference: vi.fn() }) }));
vi.mock("@/components/ui/decrypted-text", () => ({ DecryptedText: ({ text }: {text: string}) => <span>{text}</span> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("uses this installation's brand in the successful login transition", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ authenticated: true })));
  render(<LoginForm mode="demo" remotePreview={false}
    branding={{ installationId: "g03-rehearsal", companyName: "G03 · Synthetic", companySlug: "g03", publicUrl: "http://127.0.0.1:3876", productName: "G03 AI", logoPath: "/branding/g03/logo.svg", faviconPath: "/branding/g03/favicon.svg", accentColor: "#863bff" }}
    accounts={[{ id: "synthetic", name: "Synthetic Jordi", email: "qa@g03.example.test", tenantId: "g03-rehearsal", tenantName: "G03", productName: "G03 AI", description: "Synthetic only" }]} />);
  fireEvent.click(screen.getByRole("button", { name: /Synthetic Jordi/ }));
  expect(await screen.findByRole("status")).toHaveTextContent("G03 AI");
  expect(screen.getByRole("status")).not.toHaveTextContent("Arnall");
});

it.each(["private-owner", "supabase"] as const)("keeps %s controls disabled in server markup until hydration owns submission", async mode => {
  const fetch = vi.fn(async () => Response.json({ authenticated: true })); vi.stubGlobal("fetch", fetch);
  const ui = <LoginForm mode={mode} remotePreview={false} accounts={[]}
    branding={{ installationId: "g03-rehearsal", companyName: "G03 · Synthetic", companySlug: "g03", publicUrl: "http://127.0.0.1:3876", productName: "G03 AI", logoPath: "/branding/g03/logo.svg", faviconPath: "/branding/g03/favicon.svg", accentColor: "#863bff" }} />;
  const container = document.createElement("div");
  container.innerHTML = renderToString(<UiLocaleProvider locale="es">{ui}</UiLocaleProvider>);
  document.body.appendChild(container);
  const serverInputs = container.querySelectorAll("input");
  expect(serverInputs).toHaveLength(2);
  for (const input of serverInputs) expect(input).toBeDisabled();
  expect(container.querySelector('button[type="submit"]')).toBeDisabled();
  expect(fetch).not.toHaveBeenCalled();
  const hydrated = render(ui, { container, hydrate: true });
  try {
    const email = screen.getByLabelText("Correo del equipo"), password = screen.getByLabelText("Contraseña");
    expect(email).toBeEnabled(); expect(password).toBeEnabled();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
    fireEvent.change(email, { target: { value: "qa@g03.example.test" } });
    fireEvent.change(password, { target: { value: "synthetic-password-only" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("status")).toHaveTextContent("G03 AI");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ method: "POST",
      body: JSON.stringify({ email: "qa@g03.example.test", password: "synthetic-password-only" }) }));
  } finally { hydrated.unmount(); container.remove(); }
});
