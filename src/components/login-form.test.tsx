// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "../../tests/render-spanish";
import { afterEach, expect, it, vi } from "vitest";
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
