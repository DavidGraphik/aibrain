import { expect, test } from "@playwright/test";

const accountName = process.env.AIBRAIN_UI_INSTALLATION === "northwind-qa" ? "Taylor" : "Alex";

test("a long paced answer keeps rendering fluidly while Markdown grows", async ({ page }) => {
  const chromium = await page.context().newCDPSession(page);
  const controlledPerformanceRun = !process.env.CI;
  await chromium.send("Emulation.setCPUThrottlingRate", {
    // Shared CI runners have no stable hardware budget. Keep the behavioral
    // regression there, and reserve absolute frame timing for the controlled
    // local performance run documented in PERFORMANCE_BUDGETS.md.
    rate: controlledPerformanceRun ? 4 : 1,
  });
  const paragraph = "La resposta ha d'arribar de manera contínua, mantenint el xat interactiu i sense salts visibles mentre el contingut creix. ";
  // Each provider fragment is painted directly, without artificial subdivision.
  // Keep >100 real opportunities to render and retain the existing frame budgets.
  const fragments = Array.from({ length: 144 }, (_, index) =>
    index % 6 === 0 ? `\n\n### Bloc ${index / 6 + 1}\n\n${paragraph}` : paragraph,
  );

  await page.addInitScript(({ streamedFragments }) => {
    const state = window as typeof window & {
      __aibrainStreamingFluidity?: {
        frameGaps: number[];
        mutationTimes: number[];
        longTasks: number[];
        reset: () => void;
        stop: () => void;
      };
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/api/chat")) return nativeFetch(input, init);

      const encoder = new TextEncoder();
      let timer = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let index = 0;
          const enqueue = () => {
            if (init?.signal?.aborted) {
              controller.close();
              return;
            }
            if (index >= streamedFragments.length) {
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done" })}\n`));
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: "delta", value: streamedFragments[index] })}\n`));
            index += 1;
            timer = window.setTimeout(enqueue, 80);
          };
          enqueue();
        },
        cancel() {
          window.clearTimeout(timer);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      });
    };

    const frameGaps: number[] = [];
    const mutationTimes: number[] = [];
    const longTasks: number[] = [];
    let active = true;
    let previousFrame = performance.now();
    const frame = (now: number) => {
      frameGaps.push(now - previousFrame);
      previousFrame = now;
      if (active) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const observer = new MutationObserver(() => mutationTimes.push(performance.now()));
    const longTaskObserver = typeof PerformanceObserver === "undefined"
      ? null
      : new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
    try {
      longTaskObserver?.observe({ type: "longtask", buffered: true });
    } catch {
      // Long-task entries are optional in headless Chromium.
    }
    state.__aibrainStreamingFluidity = {
      frameGaps,
      mutationTimes,
      longTasks,
      reset: () => {
        frameGaps.length = 0;
        mutationTimes.length = 0;
        longTasks.length = 0;
        previousFrame = performance.now();
      },
      stop: () => {
        active = false;
        observer.disconnect();
        longTaskObserver?.disconnect();
      },
    };
    const observeDocument = () => {
      if (document.documentElement) {
        observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
      }
    };
    if (document.documentElement) observeDocument();
    else document.addEventListener("DOMContentLoaded", observeDocument, { once: true });
  }, { streamedFragments: fragments });

  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(accountName) }).click();
  await page.getByRole("textbox", { name: "Mensaje" }).fill("Escribe una respuesta larga para medir la fluidez del streaming.");
  await page.evaluate(() => (window as typeof window & {
    __aibrainStreamingFluidity?: { reset: () => void };
  }).__aibrainStreamingFluidity?.reset());
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.getByRole("heading", { name: "Bloc 24" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Detener respuesta" })).toHaveCount(0);
  const answer = page.locator("article").filter({ has: page.getByRole("heading", { name: "Bloc 24" }) });
  await expect(answer.getByRole("heading")).toHaveText(
    Array.from({ length: 24 }, (_, index) => `Bloc ${index + 1}`),
  );
  await expect(answer.locator("p")).toHaveText(Array.from({ length: 24 }, () => paragraph.repeat(6).trim()));

  const metrics = await page.evaluate(() => {
    const state = (window as typeof window & {
      __aibrainStreamingFluidity?: {
        frameGaps: number[];
        mutationTimes: number[];
        longTasks: number[];
        reset: () => void;
        stop: () => void;
      };
    }).__aibrainStreamingFluidity;
    if (!state) throw new Error("streaming metrics were not initialized");
    state.stop();
    const percentile = (values: number[], ratio: number) => {
      if (!values.length) return 0;
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
    };
    return {
      frameCount: state.frameGaps.length,
      frameGapP95Ms: percentile(state.frameGaps, 0.95),
      frameGapMaxMs: Math.max(0, ...state.frameGaps),
      framesOver50Ms: state.frameGaps.filter((gap) => gap > 50).length,
      slowFrameRatio: state.frameGaps.length
        ? state.frameGaps.filter((gap) => gap > 50).length / state.frameGaps.length
        : 0,
      longTaskCount: state.longTasks.length,
      longTaskTotalMs: state.longTasks.reduce((total, duration) => total + duration, 0),
      mutationCount: state.mutationTimes.length,
    };
  });

  test.info().attach("streaming-fluidity.json", {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: "application/json",
  });
  console.log(`streaming-fluidity ${JSON.stringify(metrics)}`);

  expect(metrics.frameCount).toBeGreaterThan(100);
  expect(metrics.mutationCount).toBeGreaterThan(100);
  if (controlledPerformanceRun) {
    expect(metrics.frameGapP95Ms).toBeLessThan(50);
    expect(metrics.slowFrameRatio).toBeLessThan(0.05);
    expect(metrics.longTaskTotalMs).toBeLessThan(500);
  }
});
