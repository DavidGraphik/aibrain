import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const voiceProbe = { requests: 0, stoppedTracks: 0 };
    class MockRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onstart: (() => void) | null = null;
      onresult: ((event: { resultIndex: number; results: Array<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
      onerror: (() => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        this.onstart?.();
        window.setTimeout(() => this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "resumen de ventas" } }] }), 10);
      }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    class MockUtterance {
      lang = "";
      rate = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: MockRecognition });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: MockUtterance });
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak() {}, cancel() {}, speaking: false } });
    Object.defineProperty(window, "__voiceProbe", { configurable: true, value: voiceProbe });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia(constraints: MediaStreamConstraints) {
          voiceProbe.requests += constraints.audio ? 1 : 0;
          return {
            getTracks: () => [{ stop: () => { voiceProbe.stoppedTracks += 1; } }],
          };
        },
      },
    });
  });
  await page.goto("/login");
  await page.getByRole("button", { name: /Alex|Taylor/ }).click();
  await expect(page.getByTestId("composer")).toBeVisible({ timeout: 30_000 });
});

test("voice dictation requires consent and leaves text editable without sending", async ({ page }) => {
  const textarea = page.getByRole("textbox", { name: "Mensaje" });
  await textarea.fill("Prepara un");
  await page.getByRole("button", { name: "Dictar mensaje" }).click();
  await expect(page.getByRole("dialog", { name: "Permiso para dictar" })).toContainText("nunca enviará");
  await page.getByRole("button", { name: "Activar dictado" }).click();
  await expect(textarea).toHaveValue("Prepara un resumen de ventas");
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__voiceProbe"))).toEqual({ requests: 1, stoppedTracks: 1 });
  await expect(page.locator("article.flex.justify-end")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enviar mensaje" })).toBeEnabled();
});

test("voice controls remain usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const button = page.getByRole("button", { name: "Dictar mensaje" });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
});
