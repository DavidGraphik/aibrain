import { handleOutlookDesktopAgentRequest } from "@/connectors/outlook-desktop-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleOutlookDesktopAgentRequest("poll", request); }
