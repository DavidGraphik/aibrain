import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { establishDemoSession } from "../helpers/playwright-auth";

// Only this isolated test connects to a loopback fixture on a second port.
// Production CSP remains unchanged.
test.use({ bypassCSP: true });

/** Real HTTP transport and a durable-in-fixture turn; provider effects are isolated. */
test("a network cut during streaming recovers the saved answer without another effect", async ({ page }) => {
  test.setTimeout(60_000);
  const requests: string[] = [];
  const subscribers = new Set<ServerResponse>();
  let workStarts = 0, effects = 0;
  let message: Record<string, unknown> | null = null;
  let finish: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push(body);
    const request = JSON.parse(body);
    if (!message) {
      workStarts++;
      message = { id: request.assistantMessageId, role: "assistant", content: "Primer fragmento. ", status: "streaming",
        createdAt: new Date().toISOString(), activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [] };
      finish = () => {
        effects++;
        message = { ...message, content: "Primer fragmento. Resultado guardado una sola vez.", status: "complete" };
        for (const client of subscribers) client.end(JSON.stringify({ type: "snapshot", message }) + "\n");
        subscribers.clear();
      };
    }
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
    res.write(JSON.stringify({ type: "snapshot", message }) + "\n");
    if (message.status !== "streaming") { res.end(); return; }
    subscribers.add(res);
    res.on("close", () => subscribers.delete(res));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no port");
  const fixtureUrl = `http://127.0.0.1:${address.port}/api/chat`;
  try {
    await page.addInitScript(({ fixtureUrl }) => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url === "/api/chat" ? original(fixtureUrl, { ...init, credentials: "omit", mode: "cors" }) : original(input, init);
      };
    }, { fixtureUrl });
    await establishDemoSession(page, "example-user");
    await page.getByRole("textbox", { name: "Mensaje", exact: true }).fill("Prueba aislada de continuidad");
    await page.getByRole("button", { name: "Enviar mensaje", exact: true }).click();
    await expect(page.getByText("Primer fragmento.", { exact: false })).toBeVisible({ timeout: 20_000 });
    // Cut the real chat TCP endpoint only; the development HMR channel and
    // unrelated application requests stay connected, as in a service outage.
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    // A real connection outage longer than the old four-retry window.
    await page.waitForTimeout(12_000);
    finish!(); // The isolated worker completes while the browser is offline.
    await new Promise<void>(resolve => server.listen(address.port, "127.0.0.1", resolve));
    await expect(page.getByText("Primer fragmento. Resultado guardado una sola vez.", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("La conexión de la respuesta no se ha podido recuperar.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Detener respuesta", exact: true })).toHaveCount(0);
    expect(requests.length).toBeGreaterThan(1);
    expect(new Set(requests).size).toBe(1);
    expect(workStarts).toBe(1);
    expect(effects).toBe(1);
    await expect(page.locator("article.flex.justify-end")).toHaveCount(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
