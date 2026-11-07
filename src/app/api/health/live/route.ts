import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const processStartedAt = new Date(Date.now() - Math.round(process.uptime() * 1_000)).toISOString();

function deployedRevision() {
  const revision = process.env.AIBRAIN_REVISION?.trim() ?? "";
  return /^[0-9a-f]{40}$/u.test(revision) ? revision : null;
}

export async function GET() {
  return NextResponse.json(
    {
      schemaVersion: 1,
      status: "live",
      revision: deployedRevision(),
      processStartedAt,
      checkedAt: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
