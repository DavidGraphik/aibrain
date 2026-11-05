"use client";

import { useEffect, useState } from "react";
import { ToolTimeline } from "@/components/assistant-ui/elements/tool-timeline";
import { MarkdownMessage } from "@/components/markdown-message";

const response = "He preparat una proposta més clara i directa.\n\nLa introducció presenta l’objectiu, els lliurables estan agrupats per fase i el calendari permet revisar cada pas abans de continuar.\n\nPodem començar revisant l’abast del projecte.";
const steps = ["Revisant el context del projecte i els documents disponibles.", "Organitzant els objectius, l’abast i els lliurables.", "Preparant una proposta clara per revisar-la conjuntament."];

export function MotionPreview() {
  const [tick, setTick] = useState(0);
  const [run, setRun] = useState(0);
  const [open, setOpen] = useState(true);
  const thinking = tick < 36;
  const text = response.slice(0, Math.max(0, tick - 36) * 3);
  const streaming = text.length < response.length;
  useEffect(() => {
    let frame = 0;
    const id = window.setInterval(() => {
      frame += 1;
      setTick(frame);
      if (frame === 36) setOpen(false);
      if ((frame - 36) * 3 >= response.length) window.clearInterval(id);
    }, 65);
    return () => window.clearInterval(id);
  }, [run]);
  return <main className="mx-auto min-h-screen max-w-3xl px-6 py-20 text-[var(--text)]">
    <p className="mb-3 text-xs text-[var(--text-secondary)]">ARNALL · DEMOSTRACIÓ VISUAL</p>
    <h1 className="mb-3 text-3xl font-semibold tracking-tight">Una resposta, pas a pas.</h1>
    <p className="mb-12 text-sm text-[var(--text-secondary)]">Mostra amb contingut fictici. No executa cap petició al model.</p>
    <ToolTimeline open={open} onOpenChange={setOpen} streaming={thinking} label={thinking ? "Pensant…" : "Procés completat"} indicator={null} complete={!thinking}>
      {steps.slice(0, Math.min(3, Math.floor(tick / 12) + 1)).map((step) => <p key={step} className="py-2 text-[13px] leading-5 text-[var(--text-secondary)]">{step}</p>)}
    </ToolTimeline>
    <div className="mt-6 min-h-48"><MarkdownMessage streaming={streaming && !thinking}>{text}</MarkdownMessage></div>
    <button className="mt-10 rounded-lg border border-[var(--border)] px-4 py-2 text-sm" onClick={() => { setTick(0); setOpen(true); setRun((value) => value + 1); }}>Tornar a veure l’animació</button>
  </main>;
}
