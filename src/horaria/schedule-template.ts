import type { InstallationConfig } from "@/config/installation-schema";
import type { ArnallSchedule } from "@/runtime/documents/arnall-schedule";

/** Select presentation from trusted installation config, never preview content. */
export function arnallScheduleForPreview(
  installation: Pick<InstallationConfig, "companySlug">,
  preview: Record<string, unknown>,
): ArnallSchedule | undefined {
  // Arnall's deployed installationId is company-qa; it is an isolation key,
  // not the company identity used to select this workbook template.
  if (installation.companySlug !== "arnall") return undefined;
  const schedule = preview.excelSchedule;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule) ||
      !("establishmentId" in schedule) || schedule.establishmentId !== preview.establecimientoId ||
      !("week" in schedule) || schedule.week !== preview.semana) {
    throw new Error("Faltan los datos de la plantilla Excel obligatoria. No se puede sustituir por otro formato.");
  }
  // The workbook generator validates all people, shifts and template capacity.
  return schedule as ArnallSchedule;
}
