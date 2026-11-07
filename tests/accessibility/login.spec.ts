import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("login has no critical or serious accessibility violations", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("aibrain:theme", "light"));
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Accede a tu espacio" })).toBeVisible();

  const audit = await new AxeBuilder({ page }).analyze();
  const blocking = audit.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious"
  );
  expect(blocking, blocking.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
});
