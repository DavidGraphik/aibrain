import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("login light is deterministic and installation branded", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("aibrain:theme", "light"));
  await page.goto("/login");
  await expect(page).toHaveTitle("Example AI · Example Laboratory");
  await expect(page.locator("html")).toHaveAttribute("data-installation", "example-lab-playwright");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("img", { name: "Example AI, Example Laboratory" })).toBeVisible();
  await expect(page).toHaveScreenshot("example-login-light.png", { fullPage: true });
});

test("login dark preserves hierarchy and contrast", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("aibrain:theme", "dark"));
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "Accede a tu espacio" })).toBeVisible();
  await expect(page).toHaveScreenshot("example-login-dark.png", { fullPage: true });
});
