// @vitest-environment jsdom

import { render, screen } from "../render-spanish";
import { describe, expect, it } from "vitest";
import { BrandMark, Button, IconButton } from "@/components/ui/primitives";
import { resolveUiInstallationBranding } from "@/ui/installation-branding";

describe("UI primitives", () => {
  it("keeps buttons accessible without relying on icon shape", () => {
    render(<><Button>Continúa</Button><IconButton label="Cerrar"><span aria-hidden>×</span></IconButton></>);
    expect(screen.getByRole("button", { name: "Continúa" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cerrar" })).toHaveAttribute("title", "Cerrar");
  });

  it("renders installation-owned brand text and asset", () => {
    const branding = resolveUiInstallationBranding("northwind-qa");
    render(<BrandMark branding={branding} />);
    const brand = screen.getByRole("img", { name: "Northwind AI, Northwind Advisory QA" });
    expect(brand).not.toHaveTextContent("Northwind AI");
    expect(brand.querySelector("img")).toHaveAttribute("src", expect.stringContaining("northwind-qa/logo.svg"));
  });
});
