import { getSession } from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";
import { proxyCMS } from "@/insijets/cms-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const session = await getSession();
  const installation = await loadInstallationConfig();
  const { path } = await context.params;
  return proxyCMS(request, { installationId: installation.installationId,
    enabled: process.env.AIBRAIN_INSIJETS_CMS_ENABLED === "true",
    upstreamOrigin: process.env.AIBRAIN_INSIJETS_CMS_ORIGIN || "",
    brainOrigin: new URL(installation.publicUrl).origin,
    signingKey: process.env.AIBRAIN_INSIJETS_CMS_SIGNING_KEY || "" }, session, "/" + path.join("/"));
}
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return handle(request, context);
}
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return handle(request, context);
}
export async function PUT(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return handle(request, context);
}
export async function DELETE(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return handle(request, context);
}
