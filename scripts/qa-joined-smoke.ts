import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const root = process.argv[2];
  if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith("aibrain-joined-qa-")) throw new Error("Use the root printed by qa-joined-browser");
  const origin = "https://127.0.0.1:3196";
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: path.join(root, "storage-0.json"), viewport: { width: 1440, height: 1000 } });
    const session = await context.request.get(`${origin}/api/auth/session`);
    expect(session.ok()).toBe(true);
    const identity = await session.json();
    expect(identity.session.provider).toBe("local");
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByText("Browser fixture", { exact: true }).first().click();
    await page.getByRole("button", { name: "Reabrir Joined fixture" }).click();
    const image = page.getByAltText("Vista actual del navegador privado");
    await expect(image).toBeVisible();
    await image.evaluate((element) => new Promise<void>((resolve) => {
      if ((element as HTMLImageElement).complete) resolve(); else element.addEventListener("load", () => resolve(), { once: true });
    }));
    const dimensions = await image.evaluate((element) => ({ width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight }));
    const bounds = await image.boundingBox();
    if (!bounds) throw new Error("Missing viewport");
    await page.mouse.click(bounds.x + bounds.width * 60 / dimensions.width, bounds.y + bounds.height * 45 / dimensions.height);
    await expect(image).toBeFocused();
    await page.keyboard.press("a");
    // Dispatch the actual DOM clipboard event; its bytes must pass signed gateway and real CDP.
    await image.evaluate((element) => { const data = new DataTransfer(); data.setData("text/plain", "Català ñ 日本語 👩🏽‍💻"); element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data })); });
    const threadsResponse = await context.request.get(`${origin}/api/threads`);
    const { threads } = await threadsResponse.json();
    const thread = threads.find((item: { title: string }) => item.title === "Browser fixture");
    const readback = () => readFile(path.join(root, `readback-${thread.id}.json`), "utf8").then(JSON.parse);
    await expect.poll(async () => (await readback()).text).toBe("aCatalà ñ 日本語 👩🏽‍💻");
    await page.keyboard.press("z");
    await expect.poll(async () => (await readback()).text).toBe("aCatalà ñ 日本語 👩🏽‍💻z");
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await readback()).text).toBe("aCatalà ñ 日本語 👩🏽‍💻");
    await page.mouse.click(bounds.x + bounds.width * 35 / dimensions.width, bounds.y + bounds.height * 112 / dimensions.height);
    await expect.poll(async () => (await readback()).clicks).toBe(1);
    await page.mouse.wheel(0, 350);
    await expect.poll(async () => (await readback()).scrollY).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(root, "joined-input.png") });
    const denied = await browser.newContext({ ignoreHTTPSErrors: true, storageState: path.join(root, "storage-1.json") });
    expect((await denied.request.get(`${origin}/api/threads/${thread.id}`)).status()).toBe(404);
    console.log(JSON.stringify({ passed: true, auth: "local", input: "exact Unicode + Backspace + click + scroll", foreignThreadStatus: 404, root }));
    await context.close();
    await denied.close();
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
