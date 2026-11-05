import { describe, expect, it } from "vitest";
import { requiresFictionalScheduleArtifact } from "./fictional-schedule-delivery";

describe("fictional Arnall schedule delivery gate", () => {
  it("requires an artifact for the reported invented-shop request", () => {
    expect(requiresFictionalScheduleArtifact("arnall", "Cas completament fictici per a una demostració. Genera l'horari de la Botiga Demo amb les sis persones inventades.")).toBe(true);
    expect(requiresFictionalScheduleArtifact("arnall", "Crea un horario ficticio y entrega el Excel.")).toBe(true);
    expect(requiresFictionalScheduleArtifact("arnall", "Vull generar un horari amb dades fictícies.")).toBe(true);
    expect(requiresFictionalScheduleArtifact("arnall", "Genera un horario ficticio, no lo guardes ni envíes.")).toBe(true);
  });

  it("does not redirect real-shop or explanatory turns or another installation", () => {
    expect(requiresFictionalScheduleArtifact("arnall", "Genera l'horari real de S'Agaró.")).toBe(false);
    expect(requiresFictionalScheduleArtifact("arnall", "Per què no ha generat l'horari fictici?")).toBe(false);
    expect(requiresFictionalScheduleArtifact("other", "Crea un horari fictici.")).toBe(false);
    expect(requiresFictionalScheduleArtifact("arnall", "Prepara un horario real de Girona. Excluye PROVA. No amplíes horas contractuales ni mínimos ficticios.")).toBe(false);
    expect(requiresFictionalScheduleArtifact("arnall", "Genera l'horari de Girona sense dades fictícies.")).toBe(false);
    expect(requiresFictionalScheduleArtifact("arnall", "No es una demo; genera el horario real de Girona.")).toBe(false);
  });

  it.each([
    "Validarem la guia d’horaris amb dades fictícies separades. Consulta el meu accés i les botigues actuals. Prepara l’alta d’una botiga nova anomenada PROVA GUIA 20261008. Mostra la proposta i espera confirmació.",
    "Prepara l’alta d’un treballador fictici per gestionar els horaris.",
    "Crea una botiga fictícia per a les proves del circuit d’horaris.",
    "Crea una guía para gestionar horarios con ejemplos ficticios.",
    "Create a fictitious employee to test schedules.",
    "Explica com generar un horari fictici.",
    "No prepares un horario ficticio. Muestra la ficha del empleado.",
  ])("does not require a workbook for administrative or explanatory requests: %s", (message) => {
    expect(requiresFictionalScheduleArtifact("arnall", message)).toBe(false);
  });

  it.each([
    "Prepara un esborrany de l’horari per a una botiga fictícia.",
    "Crea una botiga fictícia. Després genera l’horari setmanal amb persones inventades.",
    "Cas fictici. Prepara una proposta d’horari, amb Excel.",
    "Generate a weekly schedule for a fictitious shop.",
  ])("still requires the original workbook when a schedule is requested: %s", (message) => {
    expect(requiresFictionalScheduleArtifact("arnall", message)).toBe(true);
  });
});
