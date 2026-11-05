"use client";
import { spanishUiText, type UiText } from "@/i18n/messages";
import { useUiText } from "@/i18n/provider";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CaretDown,
  CaretUp,
  ChartBar,
  CheckCircle,
  FileText,
  MagicWand,
  Scales,
  Sparkle,
} from "@phosphor-icons/react";

export type GuidedActionId = "analyze" | "create" | "improve" | "summarize" | "compare";

type GuidedAction = {
  id: GuidedActionId;
  label: string;
  detail: string;
  result: string;
  icon: typeof ChartBar;
};

type ProjectTemplate = {
  label: string;
  detail: string;
  action: GuidedActionId;
  goal: string;
};

const actions: GuidedAction[] = [
  { id: "analyze", label: "Analiza", detail: "Encuentra puntos clave, riesgos y oportunidades", result: "Un análisis claro con conclusiones y siguientes pasos", icon: ChartBar },
  { id: "create", label: "Crea", detail: "Prepara un documento, correo o propuesta", result: "Un primer borrador listo para revisar", icon: FileText },
  { id: "improve", label: "Mejora", detail: "Haz un contenido más claro, completo o efectivo", result: "Una versión mejorada con los cambios explicados", icon: MagicWand },
  { id: "summarize", label: "Resume", detail: "Reduce información larga a lo que importa", result: "Un resumen adaptado a quien debe leerlo", icon: Sparkle },
  { id: "compare", label: "Compara", detail: "Contrasta dos opciones con criterios útiles", result: "Una comparación visual y una recomendación razonada", icon: Scales },
];

const projectTemplates: ProjectTemplate[] = [
  {
    label: "Informe de seguimiento",
    detail: "Convierte notas y datos en un informe accionable",
    action: "create",
    goal: "Prepara un informe breve con situación actual, decisiones, riesgos y próximos pasos.",
  },
  {
    label: "Resumen de reunión",
    detail: "Extrae acuerdos, responsables y fechas",
    action: "summarize",
    goal: "Resume la reunión para el equipo, destacando acuerdos, responsables, fechas y pendientes.",
  },
  {
    label: "Decisión entre opciones",
    detail: "Compara alternativas con criterios claros",
    action: "compare",
    goal: "Compara coste, tiempo, riesgo, impacto y facilidad de implantación.",
  },
];

const copy: Record<GuidedActionId, {
  heading: string;
  sourceLabel: string;
  sourcePlaceholder: string;
  secondLabel?: string;
  secondPlaceholder?: string;
  goalLabel: string;
  goalPlaceholder: string;
}> = {
  analyze: {
    heading: "¿Qué quieres entender mejor?",
    sourceLabel: "Información que debemos analizar",
    sourcePlaceholder: "Pega el texto, describe la situación o indica dónde está la información…",
    goalLabel: "¿Qué necesitas decidir o descubrir?",
    goalPlaceholder: "Ej.: detectar riesgos antes de presentar la propuesta",
  },
  create: {
    heading: "¿Qué necesitas crear?",
    sourceLabel: "Tipo de resultado",
    sourcePlaceholder: "Ej.: un correo a un cliente, una propuesta, un informe o una lista de comprobación",
    goalLabel: "Información que debe incluir",
    goalPlaceholder: "Escribe las ideas, datos y condiciones importantes…",
  },
  improve: {
    heading: "¿Qué quieres mejorar?",
    sourceLabel: "Versión actual",
    sourcePlaceholder: "Pega aquí el contenido actual…",
    goalLabel: "¿Cómo debería quedar?",
    goalPlaceholder: "Ej.: más breve, más claro y con un tono profesional",
  },
  summarize: {
    heading: "¿Qué quieres resumir?",
    sourceLabel: "Contenido original",
    sourcePlaceholder: "Pega el texto o describe la información que hay que resumir…",
    goalLabel: "¿Para quién es y qué extensión quieres?",
    goalPlaceholder: "Ej.: para dirección, máximo cinco puntos",
  },
  compare: {
    heading: "¿Qué opciones quieres comparar?",
    sourceLabel: "Primera opción",
    sourcePlaceholder: "Describe la opción A…",
    secondLabel: "Segunda opción",
    secondPlaceholder: "Describe la opción B…",
    goalLabel: "¿Qué es más importante para decidir?",
    goalPlaceholder: "Ej.: coste, tiempo, riesgo y facilidad de uso",
  },
};

function buildPrompt(action: GuidedAction, source: string, second: string, goal: string, projectName: string, t: UiText = spanishUiText) {
  const instruction = {
    analyze: t("Analiza la información, separa observaciones de conclusiones, identifica riesgos y oportunidades y termina con siguientes pasos concretos."),
    create: t("Crea el resultado pedido en una versión completa, clara y lista para revisar. Si falta un dato imprescindible, haz una sola pregunta concreta antes de continuar."),
    improve: t("Mejora el contenido manteniendo su significado. Devuelve primero la versión final y después explica brevemente los cambios importantes."),
    summarize: t("Resume la información para el destinatario indicado. Prioriza decisiones, fechas, riesgos y acciones; elimina repeticiones."),
    compare: t("Compara las dos opciones con los criterios indicados. Utiliza una tabla clara y termina con una recomendación, incluidos los condicionantes."),
  }[action.id];
  return [
    t("Acción guiada: {p0}.", { p0: t(action.label) }),
    t("Proyecto: {name}.", { name: projectName }),
    t(instruction),
    t("Información principal:\n{p0}", { p0: source.trim() }),
    ...(second.trim() ? [t("Segunda opción:\n{p0}", { p0: second.trim() })] : []),
    t("Objetivo y criterios:\n{goal}", { goal: goal.trim() }),
    t("Escribe el resultado en lenguaje natural, sin terminología técnica innecesaria."),
  ].join("\n\n");
}

export function GuidedActions({
  projectName,
  projectId,
  onCancel,
  onWriteDirectly,
  onStart,
}: {
  projectName: string;
  projectId: string | null;
  onCancel?: () => void;
  onWriteDirectly?: () => void;
  onStart: (prompt: string, summary: string) => void;
}) {
  const t = useUiText();
  const [selectedId, setSelectedId] = useState<GuidedActionId | null>(null);
  const [source, setSource] = useState("");
  const [second, setSecond] = useState("");
  const [goal, setGoal] = useState("");
  const [savedTemplates, setSavedTemplates] = useState<ProjectTemplate[]>([]);
  const [showAllActions, setShowAllActions] = useState(false);
  const selected = useMemo(() => actions.find((action) => action.id === selectedId) ?? null, [selectedId]);
  const formCopy = selected ? copy[selected.id] : null;
  const ready = Boolean(selected && source.trim() && goal.trim() && (selected.id !== "compare" || second.trim()));
  const storageKey = projectId ? `aibrain.project.${projectId}.guided-templates.v1` : null;
  const quickTemplates = useMemo(
    () => [...savedTemplates, ...projectTemplates.map(template => ({ ...template, label: t(template.label), detail: t(template.detail), goal: t(template.goal) }))]
      .filter((template, index, templates) => templates.findIndex((candidate) => candidate.label === template.label) === index)
      .slice(0, 3),
    [savedTemplates, t],
  );

  useEffect(() => {
    if (!storageKey) return;
    const frame = requestAnimationFrame(() => {
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
        if (Array.isArray(parsed)) {
          setSavedTemplates(parsed.filter((item): item is ProjectTemplate => Boolean(item && typeof item === "object" && "label" in item && "detail" in item && "action" in item && "goal" in item)).slice(0, 12));
        }
      } catch {
        setSavedTemplates([]);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [storageKey]);

  const saveCurrentTemplate = () => {
    if (!selected || !goal.trim() || !storageKey) return;
    const template: ProjectTemplate = {
      label: `${t(selected.label)}: ${goal.trim().slice(0, 42)}${goal.trim().length > 42 ? "…" : ""}`,
      detail: t("Plantilla guardada en {name}", { name: projectName }),
      action: selected.id,
      goal: goal.trim(),
    };
    const next = [template, ...savedTemplates.filter((item) => item.label !== template.label)].slice(0, 12);
    setSavedTemplates(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  };

  const selectTemplate = (template: ProjectTemplate) => {
    setSelectedId(template.action);
    setSource("");
    setSecond("");
    setGoal(template.goal);
  };

  if (!selected || !formCopy) {
    return (
      <section className="mx-auto flex min-h-full w-full max-w-[860px] flex-col justify-center px-5 py-10 md:px-10">
        {onCancel ? <button type="button" className="mb-7 flex min-h-10 w-fit items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] font-medium text-[var(--text)] hover:bg-[var(--surface-muted)]" onClick={onCancel}><ArrowLeft size={13} /> {" "}{t("Volver a la conversación")}</button> : null}
        <h1 className="max-w-2xl text-balance text-[32px] font-semibold leading-[1.05] tracking-[-.04em] text-[var(--text)] md:text-[42px]">{t("¿Qué quieres conseguir?")}</h1>
        <p className="mt-4 max-w-[62ch] text-[15px] leading-6 text-[var(--text-secondary)]">{t("Elige un punto de partida. Te pediremos solo la información necesaria y prepararemos el trabajo dentro de")}{" "}{projectName}.</p>
        <ol aria-label={t("Cómo funciona")} className="guided-trace mt-6 grid max-w-2xl grid-cols-3">
          {[t("Define el objetivo"), t("Añade información"), t("Revisa el resultado")].map((step, index) => <li key={step} className="guided-trace-step"><span>{index + 1}</span><strong>{step}</strong></li>)}
        </ol>
        {onWriteDirectly ? <button type="button" className="mt-4 min-h-10 w-fit rounded-lg px-2 py-2 text-[12px] font-medium text-[var(--text)] underline decoration-[var(--border-strong)] underline-offset-4" onClick={onWriteDirectly}>{t("Prefiero escribir directamente")}</button> : null}
        <div className="mt-8">
          <p className="text-[12px] font-semibold text-[var(--text)]">{t("Plantillas rápidas de")}{" "}{projectName}</p>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            {quickTemplates.map((template) => (
              <button key={template.label} type="button" className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-left transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]" onClick={() => selectTemplate(template)}>
                <span className="block text-[13px] font-semibold text-[var(--text)]">{template.label}</span>
                <span className="mt-1.5 block text-[12px] leading-5 text-[var(--text-secondary)]">{template.detail}</span>
              </button>
            ))}
          </div>
        </div>
        <button type="button" aria-expanded={showAllActions} className="mt-5 flex min-h-11 w-fit items-center gap-2 rounded-xl px-2 text-[13px] font-semibold text-[var(--text)] transition hover:bg-[var(--surface-muted)]" onClick={() => setShowAllActions((visible) => !visible)}>
          {showAllActions ? <CaretUp size={14} /> : <CaretDown size={14} />}{showAllActions ? t("Ocultar otras acciones") : t("Ver todas las acciones")}
        </button>
        {showAllActions ? <div className="mt-2 divide-y divide-[var(--border-subtle)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-raised)]">
          {actions.map((action) => {
            const Icon = action.icon;
            return <button type="button" key={action.id} className="group flex min-h-14 w-full items-center gap-4 bg-[var(--surface-raised)] px-5 py-4 text-left transition hover:bg-[var(--surface-muted)] focus-visible:z-10 md:px-6" onClick={() => setSelectedId(action.id)}><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--surface-muted)] text-[var(--text)] transition group-hover:bg-[var(--brain-accent-soft)] group-hover:text-[var(--brain-accent)]"><Icon size={16} /></span><span className="min-w-0 flex-1 md:grid md:grid-cols-[130px_1fr] md:items-center md:gap-5"><span className="text-[14px] font-semibold text-[var(--text)]">{t(action.label ?? "")}</span><span><span className="block text-[13px] leading-5 text-[var(--text-secondary)]">{t(action.detail ?? "")}</span><span className="mt-1 block text-[12px] leading-5 text-[var(--text-muted)]">{t(action.result ?? "")}</span></span></span><ArrowRight size={15} className="shrink-0 text-[var(--text-muted)] transition group-hover:translate-x-1 group-hover:text-[var(--text)]" /></button>;
          })}
        </div> : null}
      </section>
    );
  }
  const SelectedIcon = selected.icon;

  return (
    <section className="mx-auto w-full max-w-[760px] px-5 py-8 md:px-8 md:py-12">
      <button type="button" className="flex min-h-10 items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] font-medium text-[var(--text)] hover:bg-[var(--surface-muted)]" onClick={() => setSelectedId(null)}><ArrowLeft size={12} /> {" "}{t("Cambiar de acción")}</button>
      <div className="mt-7 flex items-start gap-4"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--brain-accent-soft)] text-[var(--brain-accent-on-soft)]"><SelectedIcon size={18} /></span><div><h2 className="text-[30px] font-semibold tracking-[-.035em] text-[var(--text)]">{t(formCopy.heading ?? "")}</h2><p className="mt-2 text-[12px] leading-5 text-[var(--text-secondary)]">{t("Plantilla “")}{t(selected.label ?? "")}{t("” para el proyecto")}{" "}{projectName}.</p></div></div>
      <div className="mt-8 space-y-6">
        <label className="block"><span className="mb-2 block text-[12px] font-semibold text-[var(--text)]">{t(formCopy.sourceLabel ?? "")}</span><textarea rows={selected.id === "create" ? 2 : 5} maxLength={12_000} value={source} onChange={(event) => setSource(event.target.value)} placeholder={t(formCopy.sourcePlaceholder ?? "")} className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3 text-[14px] leading-6 text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--focus)]" /></label>
        {formCopy.secondLabel ? <label className="block"><span className="mb-2 block text-[12px] font-semibold text-[var(--text)]">{t(formCopy.secondLabel ?? "")}</span><textarea rows={4} maxLength={8_000} value={second} onChange={(event) => setSecond(event.target.value)} placeholder={t(formCopy.secondPlaceholder ?? "")} className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3 text-[14px] leading-6 text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--focus)]" /></label> : null}
        <label className="block"><span className="mb-2 block text-[12px] font-semibold text-[var(--text)]">{t(formCopy.goalLabel ?? "")}</span><textarea rows={3} maxLength={2_000} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t(formCopy.goalPlaceholder ?? "")} className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3 text-[14px] leading-6 text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--focus)]" /></label>
      </div>
      <div className="mt-7 flex flex-col gap-4 border-t border-[var(--border-subtle)] pt-6 sm:flex-row sm:items-center"><div className="flex min-w-0 flex-1 items-start gap-2 text-[12px] leading-5 text-[var(--text-secondary)]"><CheckCircle size={14} className="mt-0.5 shrink-0 text-[var(--positive)]" />{t(selected.result ?? "")}{t(". Podrás revisarlo antes de utilizarlo.")}</div><div className="flex flex-col gap-2 sm:flex-row"><button type="button" disabled={!goal.trim() || !storageKey} className="min-h-11 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3 text-[12px] font-semibold text-[var(--text)] disabled:opacity-40" onClick={saveCurrentTemplate}>{t("Guardar en el proyecto")}</button><button type="button" disabled={!ready} className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--brain-accent)] px-5 py-3 text-[13px] font-semibold text-[var(--brain-contrast)] transition active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-35" onClick={() => ready && onStart(buildPrompt(selected, source, second, goal, projectName, t), `${t(selected.label)}: ${goal.trim()}`)}>{t("Empezar")}{" "}<ArrowRight size={13} /></button></div></div>
    </section>
  );
}
