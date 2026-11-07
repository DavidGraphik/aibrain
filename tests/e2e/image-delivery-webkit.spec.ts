import { reloadAndReopenConversation } from "../helpers/reopen-conversation";
import { expect, test as base, type Page } from "@playwright/test";
import { createServer, request as httpRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import { generatedPngFixture } from "../helpers/png-fixture";
import AxeBuilder from "@axe-core/playwright";

const artifactId = "018f5f68-4a6e-7abc-8def-0123456789aa";
const artifactName = "imagen-webkit.png";
const artifactPrompt = "Imagen PNG visible en Safari móvil con una descripción extensa y sin recortar las acciones de descarga " + "detalle".repeat(35);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// WebKit's native download process bypasses Playwright page.route. Serve
// fixture bytes over real HTTP, including the download, instead of allowing
// that process to hit the real API with a nonexistent mocked artifact id.
const test = base.extend<{ imageServer: { url: string; requests: Array<{ download: boolean; authenticated: boolean }> } }>({
  imageServer: async ({ baseURL }, provideImageServer) => {
    if (!baseURL) throw new Error("baseURL required");
    const png = generatedPngFixture();
    const requests: Array<{ download: boolean; authenticated: boolean }> = [];
    const upgradedSockets = new Set<Duplex>();
    const upstreamOrigin = new URL(baseURL);
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", baseURL);
      if (url.pathname.endsWith(`/artifacts/${artifactId}`)) {
        // Validate the actual signed-in demo session with the app; never log
        // or persist cookie values. Resource permission tests remain backend gates.
        const session = await fetch(new URL("/api/auth/session", baseURL), {
          headers: { Cookie: request.headers.cookie ?? "" },
        });
        const download = url.searchParams.get("download") === "1";
        requests.push({ download, authenticated: session.ok });
        if (!session.ok) { response.writeHead(401); response.end(); return; }
        response.writeHead(200, {
          "Cache-Control": "private, no-store",
          "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${artifactName}"`,
          "Content-Length": String(png.byteLength),
          "Content-Type": "image/png",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(png);
        return;
      }
      const upstream = httpRequest(url, { method: request.method, headers: { ...request.headers, host: url.host } }, (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      });
      upstream.on("error", () => { response.writeHead(502); response.end(); });
      request.pipe(upstream);
    });
    // The workbench readiness stream and Next development transport both use
    // WebSockets. Keep the proxy a faithful same-origin surface so readiness
    // is real rather than bypassed for this WebKit-only download fixture.
    server.on("upgrade", (request, socket, head) => {
      const upstream = connectTcp(Number(upstreamOrigin.port), upstreamOrigin.hostname, () => {
        const headers: string[] = [];
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
          if (request.rawHeaders[index]?.toLowerCase() === "host") continue;
          headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
        }
        headers.push(`Host: ${upstreamOrigin.host}`);
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`);
        if (head.byteLength > 0) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upgradedSockets.add(socket);
      upgradedSockets.add(upstream);
      socket.once("close", () => upgradedSockets.delete(socket));
      upstream.once("close", () => upgradedSockets.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture address missing");
    try { await provideImageServer({ url: `http://127.0.0.1:${address.port}`, requests }); }
    finally {
      for (const socket of upgradedSockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
});

async function login(page: Page, baseURL: string) {
  const response = await page.request.post("/api/auth/login", {
    headers: { Origin: new URL(baseURL).origin },
    data: { userId: "example-user" },
  });
  expect(response.status()).toBe(200);
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "false");
}

test("an authenticated PNG remains visible and downloadable after reload in iPhone WebKit", async ({
  browserName,
  page,
  imageServer,
  baseURL,
}) => {
  expect(browserName).toBe("webkit");
  expect(page.viewportSize()).toEqual({ width: 390, height: 664 });

  const png = generatedPngFixture();
  expect(png.byteLength).toBeGreaterThan(1_024);
  expect(png.subarray(0, pngSignature.length)).toEqual(pngSignature);

  const artifactRequests: Array<{ download: boolean; resourceType: string }> = [];
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.endsWith(`/artifacts/${artifactId}`)) return;
    artifactRequests.push({ download: new URL(request.url()).searchParams.get("download") === "1", resourceType: request.resourceType() });
  });

  await login(page, baseURL!);
  await page.goto(imageServer.url);
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(({ id, name, prompt }) => {
    const previewKey = Object.keys(localStorage).find((key) => key.endsWith(".workbench.preview.v1"));
    if (!previewKey) throw new Error("preview key missing");
    const snapshot = JSON.parse(localStorage.getItem(previewKey) ?? "null");
    const project = snapshot.projects[0];
    const threadId = crypto.randomUUID();
    const now = new Date().toISOString();
    snapshot.threads.unshift({
      id: threadId,
      projectId: project.id,
      title: "Entrega PNG móvil",
      status: "active",
      pinned: false,
      createdAt: now,
      updatedAt: now,
      messages: [{
        id: crypto.randomUUID(),
        role: "assistant",
        content: "La imagen generada está lista.",
        createdAt: now,
        status: "complete",
        activity: [],
        plan: [],
        approvals: [],
        diff: "",
        attachments: [],
        artifacts: [{
          id,
          type: "image",
          name,
          url: `/api/projects/${project.id}/artifacts/${id}`,
          prompt,
        }],
      }],
    });
    localStorage.setItem(previewKey, JSON.stringify(snapshot));
    const prefix = previewKey.slice(0, -"workbench.preview.v1".length);
    localStorage.setItem(`${prefix}selection.v1`, JSON.stringify({
      activeProjectId: project.id,
      threadByProject: { [project.id]: threadId },
    }));
  }, { id: artifactId, name: artifactName, prompt: artifactPrompt });

  await reloadAndReopenConversation(page);
  const image = page.getByRole("img", { name: artifactPrompt });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => ({
    complete: element.complete,
    naturalHeight: element.naturalHeight,
    naturalWidth: element.naturalWidth,
  }))).toMatchObject({ complete: true, naturalHeight: 32, naturalWidth: 32 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await reloadAndReopenConversation(page);
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(32);
  expect(artifactRequests.filter((request) => !request.download)).toHaveLength(2);
  expect(artifactRequests.filter((request) => !request.download).every((request) => request.resourceType === "image")).toBe(true);

  const downloadLink = page.getByRole("link", { name: `Descargar ${artifactName}` });
  const bounds = await downloadLink.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    const results = await new AxeBuilder({ page }).include('[data-slot="image-generation"]').analyze();
    expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  }
  await expect(downloadLink).toHaveAttribute(
    "href",
    new RegExp(`/api/projects/[0-9a-f-]{36}/artifacts/${artifactId}\\?download=1$`, "i"),
  );
  await expect(downloadLink).toHaveAttribute("download", artifactName);

  const response = await downloadLink.evaluate(async (element: HTMLAnchorElement) => {
    const downloadResponse = await fetch(element.href, {
      cache: "no-store",
      credentials: "same-origin",
    });
    const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
    return {
      contentDisposition: downloadResponse.headers.get("content-disposition"),
      contentLength: downloadResponse.headers.get("content-length"),
      contentType: downloadResponse.headers.get("content-type"),
      length: bytes.byteLength,
      signature: Array.from(bytes.slice(0, 8)),
      status: downloadResponse.status,
    };
  });
  expect(response).toMatchObject({
    contentDisposition: `attachment; filename="${artifactName}"`,
    contentLength: String(png.byteLength),
    contentType: "image/png",
    length: png.byteLength,
    signature: Array.from(pngSignature),
    status: 200,
  });
  expect(response.length).toBeGreaterThan(1_024);
  expect(artifactRequests).toContainEqual({ download: true, resourceType: "fetch" });

  const pageUrlBeforeDownload = page.url();
  await downloadLink.click();
  // Headless WebKit on Linux may hand the native download to a process that is
  // invisible to Playwright and may also suppress the second HTTP request and
  // DOM click event. The authenticated browser-side fetch above is therefore
  // the portable HTTP boundary; Playwright's actionability check plus the exact
  // href/download attributes prove that the real control is usable.
  await expect(page).toHaveURL(pageUrlBeforeDownload);
  expect(imageServer.requests.filter((request) => request.download).length).toBeGreaterThanOrEqual(1);
  expect(imageServer.requests.every((request) => request.authenticated)).toBe(true);
});
