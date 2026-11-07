import type { WorkbenchThread } from "@/workbench/types";

export type ArchivePlanItem = {
  threadId: string;
  title: string;
  decision: "preserve" | "archive";
  reasons: string[];
};

const TEST_TITLE = /(?:^|\b)(qa|test|prueba|demo|duplicate|duplicado|smoke|e2e|untitled|sin t[ií]tulo)(?:\b|$)/iu;
const SUBSTANTIVE_TITLE = /(?:proposal|propuesta|cliente|contrato|estrategia|finance|finanzas|producto|roadmap|incident|incidente|research|investigaci[oó]n)/iu;

export function planThreadArchive(
  threads: readonly WorkbenchThread[],
  options: { now?: number; recentDays?: number; targetArchiveRatio?: number } = {},
) {
  const now = options.now ?? Date.now();
  const recentDays = options.recentDays ?? 30;
  const targetRatio = options.targetArchiveRatio ?? 0.9;
  if (!Number.isFinite(now) || !Number.isFinite(recentDays) || recentDays < 0) {
    throw new Error("Archive planning requires a finite timestamp and a non-negative recent-days value.");
  }
  if (!Number.isFinite(targetRatio) || targetRatio < 0 || targetRatio > 1) {
    throw new Error("Archive target ratio must be between 0 and 1.");
  }
  const cutoff = now - recentDays * 86_400_000;
  const active = threads.filter((thread) => thread.status === "active");
  const target = Math.floor(active.length * targetRatio);
  const scored = active.map((thread) => {
    const textLength = thread.messages.reduce((total, message) => total + message.content.trim().length, 0);
    const recent = Date.parse(thread.updatedAt) >= cutoff;
    const substantive = thread.messages.length >= 6 || textLength >= 2_000 || SUBSTANTIVE_TITLE.test(thread.title);
    const hardReasons = [
      ...(thread.pinned ? ["pinned"] : []),
      ...(recent ? ["recent"] : []),
      ...(substantive ? ["substantive"] : []),
    ];
    const candidateReasons = [
      ...(TEST_TITLE.test(thread.title) ? ["qa_or_test_title"] : []),
      ...(thread.messages.length <= 2 ? ["very_short"] : []),
      ...(textLength < 400 ? ["low_content"] : []),
    ];
    return { thread, hardReasons, candidateReasons, score: candidateReasons.length * 100 - thread.messages.length - Math.min(textLength / 100, 50) };
  });
  const candidates = scored.filter((item) => item.hardReasons.length === 0 && item.candidateReasons.length > 0)
    .sort((left, right) => right.score - left.score || left.thread.updatedAt.localeCompare(right.thread.updatedAt));
  const selected = new Set(candidates.slice(0, target).map((item) => item.thread.id));
  const items: ArchivePlanItem[] = scored.map(({ thread, hardReasons, candidateReasons }) => selected.has(thread.id) ? {
    threadId: thread.id, title: thread.title, decision: "archive", reasons: candidateReasons,
  } : {
    threadId: thread.id, title: thread.title, decision: "preserve",
    reasons: hardReasons.length ? hardReasons : candidateReasons.length ? ["target_limit"] : ["not_a_safe_candidate"],
  });
  const archiveCount = items.filter((item) => item.decision === "archive").length;
  return {
    schemaVersion: 1 as const,
    generatedAt: new Date(now).toISOString(),
    policy: { recentDays, targetArchiveRatio: targetRatio },
    totals: { active: active.length, archive: archiveCount, preserve: active.length - archiveCount, achievedArchiveRatio: active.length ? archiveCount / active.length : 0 },
    items,
  };
}
