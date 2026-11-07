import { expect, type Page } from "@playwright/test";

/** Observe login, navigation and hydration as separate phases, without selecting a project. */
export async function loginDemoEmployee(page: Page, accountName: string) {
  await page.goto("/login");
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/login" && response.request().method() === "POST"),
    page.getByRole("button", { name: new RegExp(accountName) }).click(),
  ]);
  expect(response.ok(), "the demo employee must authenticate successfully").toBe(true);
  await page.waitForURL(url => url.pathname === "/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('main[data-section="chat"]')).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("composer")).toBeVisible();
}
