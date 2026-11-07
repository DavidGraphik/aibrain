import { handleDirectory } from "@/insijets/directory-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return handleDirectory(request, "export");
}
