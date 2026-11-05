import { test, expect } from "@playwright/test";

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`validated login transition ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/login");
    // Hold only navigation, after the real synthetic login has validated.
    let release!: () => void;
    const navigation = new Promise<void>((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === "/", async (route) => {
      await navigation;
      await route.continue();
    });
    try {
      await page.getByRole("button", { name: /Alex/ }).click();
      const transition = page.getByTestId("login-transition");
      await expect(transition).toBeVisible();
      // This fixture is the Example installation, not another customer's brand.
      await expect(transition).toContainText("Cargando página… · Example AI");
      await expect(transition).not.toContainText("Arnall");
      expect(await transition.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
      await expect(page.getByRole("button", { name: /Alex/ })).toHaveCount(0);
      await page.screenshot({ path: `.impeccable/review/login-transition-${reducedMotion}.png` });
    } finally {
      release();
    }
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("login-transition")).toHaveCount(0);
    await expect(page.locator('[data-slot="stars-background"]')).toHaveCount(0);
  });
}

test("failed login retains the form without the transition", async ({ page }) => {
  await page.goto("/login");
  await page.route("**/api/auth/login", (route) => route.fulfill({ status: 401, json: { error: "Acceso denegado de prueba" } }));
  await page.getByRole("button", { name: /Alex/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Acceso denegado de prueba" })).toBeVisible();
  await expect(page.getByTestId("login-transition")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Alex/ })).toBeEnabled();
});
