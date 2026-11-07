import { loadInstallationConfig } from "@/config/installation";

export async function isSameOriginMutation(request: Request) {
  const installation = await loadInstallationConfig();
  const expectedOrigin = new URL(installation.publicUrl).origin;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";

  return process.env.NODE_ENV !== "production" && new URL(request.url).origin === expectedOrigin;
}
