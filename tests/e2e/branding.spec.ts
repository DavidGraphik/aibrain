import { expect, test } from "@playwright/test";

const northwind = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa";
const expected = northwind ? {
  installationId: "northwind-qa",
  productName: "Northwind AI",
  companyName: "Northwind Advisory QA",
  accountName: "Taylor",
  favicon: "northwind-qa/favicon.svg",
} : {
  installationId: "example-lab-playwright",
  productName: "Example AI",
  companyName: "Example Laboratory",
  accountName: "Alex",
  favicon: "example-lab/favicon.svg",
};

test("the installation changes identity without changing the login component", async ({ page }) => {
  await page.goto("/login");

  await expect(page).toHaveTitle(`${expected.productName} · ${expected.companyName}`);
  await expect(page.locator("html")).toHaveAttribute("data-installation", expected.installationId);
  await expect(page.getByRole("img", { name: `${expected.productName}, ${expected.companyName}` })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(expected.accountName) })).toBeVisible();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", new RegExp(expected.favicon.replace(".", "\\.")));
});
