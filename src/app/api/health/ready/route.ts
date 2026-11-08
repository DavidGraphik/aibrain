import { NextResponse } from "next/server";
import { automationWorkerReadinessProbe } from "@/automations/worker-status";
import { loadInstallationConfig } from "@/config/installation";
import { checkInstallationReadiness } from "@/operations/readiness";
import { runtimeReadinessProbes } from "@/operations/runtime-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configuredNonNegativeInteger(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function configuredRatio(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function automationWorkerEnabled() {
  const raw = process.env.AIBRAIN_AUTOMATION_WORKER_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  return true;
}

export async function GET() {
  try {
    const config = await loadInstallationConfig();
    const report = await checkInstallationReadiness(config, {
      minimumFreeBytes: configuredNonNegativeInteger("AIBRAIN_MINIMUM_FREE_BYTES", 1024 * 1024 * 1024),
      minimumFreeRatio: configuredRatio("AIBRAIN_MINIMUM_FREE_RATIO", 0.20),
      componentProbes: [
        ...runtimeReadinessProbes(),
        automationWorkerReadinessProbe(config.paths.dataRoot, Date.now, automationWorkerEnabled()),
      ],
    });
    return NextResponse.json(report, {
      status: report.status === "ready" ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({
      schemaVersion: 1,
      status: "degraded",
      checkedAt: new Date().toISOString(),
      disk: null,
      checks: [{ name: "data-root", status: "fail", code: "READINESS_INITIALIZATION_FAILED" }],
    }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
