"use client";
import { useUiText } from "@/i18n/provider";

import { ShieldCheck } from "@phosphor-icons/react";
import type { ApprovalItem, ApprovalDecision } from "@/lib/chat-contract";
import { publicActivityText, publicCommandTitle } from "@/ui/public-activity";
import { connectorApprovalReview } from "@/ui/connector-approval-review";

// Old cards remain inspectable; current requests are authorized in the chat.
export function PermissionGrant({
  approval,
  connectorApproval = false,
  readOnly = false,
}: {
  approval: ApprovalItem;
  onResolve: (decision: ApprovalDecision) => void;
  connectorApproval?: boolean;
  readOnly?: boolean;
}) {
  const t = useUiText();
  const pending = approval.status === "pending";
  const exactConnectorApproval = connectorApproval || Boolean(approval.authorizationFingerprint || approval.connectorAuthorizationFingerprint);
  const review = exactConnectorApproval ? connectorApprovalReview(approval.detail) : null;
  const result = {
    accepted: t("Permitido una vez"),
    accepted_session: t("Permitido durante esta tarea"),
    declined: t("Acción rechazada"),
    pending: t("Confirma la acción en el chat"),
  }[approval.status];
  const title = publicActivityText(approval.title, 240) ?? t("Acción pendiente");
  const explanation = pending
    ? t("Esta tarjeta pertenece a una solicitud anterior. Indica en el chat qué acción quieres completar para que el asistente compruebe su estado actual.")
    : t("Resultado de una solicitud anterior. Puedes consultar sus detalles.");

  return (
    <div data-slot="permission-grant" className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-raised)]" role="group" aria-label={t("Aprobación: {p0}", { p0: title })}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--surface-muted)] text-[var(--text)]">
          <ShieldCheck size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-[var(--text)]">{title}</p>
          <p className="mt-1 text-[10px] leading-4 text-[var(--text)]">{explanation}</p>
          {review ? (
            <dl className="mt-2 space-y-2 rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-[10px] leading-4">
              {review.map((field, index) => <div key={index}>
                <dt className="font-semibold">{t(field.label)}</dt>
                <dd className="mt-0.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{field.translateValue ? t(field.value) : field.value}</dd>
              </div>)}
            </dl>
          ) : <details className="mt-2" open={exactConnectorApproval}>
            <summary className="w-fit cursor-pointer text-[9px] font-medium text-[var(--text)]">{t("Ver por qué necesita permiso")}</summary>
            <div className="mt-2 rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-[9px] leading-4 text-[var(--text)]">
              <p className="whitespace-pre-wrap break-words">{exactConnectorApproval ? approval.detail : publicActivityText(approval.detail, 1_000) ?? t("Esta acción necesita confirmación.")}</p>
              {approval.command ? <p className="mt-2 text-[9px] font-medium text-[var(--text-secondary)]">{publicCommandTitle(approval.command)}</p> : null}
            </div>
          </details>}
          {approval.fileReview ? <details className="mt-2">
            <summary className="w-fit cursor-pointer text-[10px] font-medium text-[var(--text)]">{t("Revisar cambios de la web")}</summary>
            <div className="mt-2 space-y-3 text-[10px] text-[var(--text)]">
              <p className="break-all font-medium">{approval.fileReview.filename}</p>
              {approval.fileReview.changes.map((change, index) => <div key={index} className="space-y-1">
                <p>{t("Antes")}</p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-muted)] p-2">{change.before}</pre>
                <p>{t("Después")}</p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-muted)] p-2">{change.after}</pre>
              </div>)}
            </div>
          </details> : null}
        </div>
      </div>

      {pending && readOnly ? (
        <div className="border-t border-[var(--border-subtle)] px-3.5 py-2 text-[9px] font-medium text-[var(--text-secondary)]">
          {" "}{t("Esperando la decisión de un editor del proyecto")}{" "}</div>
      ) : pending ? (
        <div className="border-t border-[var(--border-subtle)] px-3.5 py-2 text-[9px] font-medium text-[var(--text)]" role="status">
          {result}
        </div>
      ) : (
        <div className="border-t border-[var(--border-subtle)] px-3.5 py-2 text-[9px] font-medium text-[var(--text)]" role="status">{result}</div>
      )}
    </div>
  );
}
