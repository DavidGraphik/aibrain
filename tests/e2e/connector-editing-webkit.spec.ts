import { expect, test } from "@playwright/test";
import { establishDemoSession, enableRouteDrivenDemoWorkbench } from "../helpers/playwright-auth";

test("mobile native text deletion and paste do not trap a connector mention", async ({ page }) => {
  await enableRouteDrivenDemoWorkbench(page);
  await page.route("**/api/connectors/mentions", route => route.fulfill({ json: { mentions: [{ id: "gmail", label: "Gmail", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: true }] } }));
  await establishDemoSession(page, "example-user");
  const input = page.getByRole("textbox", { name: "Mensaje", exact: true });
  await input.fill("@Gm");
  await page.getByRole("option", { name: /Gmail/ }).click();
  await expect(input).toHaveValue("@Gmail ");
  for (let i = 0; i < 7; i++) await input.press("Backspace");
  await expect(input).toHaveValue("");
  await page.keyboard.insertText("@Gmail pasted");
  await expect(input).toHaveValue("@Gmail pasted");
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 7));
  await page.keyboard.insertText("Plain ");
  await expect(input).toHaveValue("Plain pasted");
  await expect(page.locator(".composer-mention-overlay")).toHaveCount(0);
});
