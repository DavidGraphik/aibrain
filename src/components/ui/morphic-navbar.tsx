"use client";
import { useUiText } from "@/i18n/provider";

import { motion, useReducedMotion } from "motion/react";
import styles from "./morphic-navbar.module.css";

const items = [
  { id: "chat", name: "Xat" },
  { id: "design", name: "Disseny" },
  { id: "excel", name: "Excel" },
  { id: "schedules", name: "Horaris" },
] as const;

export type WorkbenchSection = (typeof items)[number]["id"];

export function MorphicNavbar({ value, onChange }: {
  value: WorkbenchSection;
  onChange: (value: WorkbenchSection) => void;
}) {
  const t = useUiText();
  const reducedMotion = useReducedMotion();
  return (
    <nav aria-label={t("Espais de treball")} className={styles.nav}>
      <div className={styles.group}>
        {items.map(({ id, name }, index) => (
          <motion.button
            key={id}
            type="button"
            layout={reducedMotion ? false : "position"}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            aria-pressed={value === id}
            onClick={() => onChange(id)}
            className={styles.item}
            data-active={value === id}
            data-first={index === 0 || items[index - 1]?.id === value}
            data-last={index === items.length - 1 || items[index + 1]?.id === value}
          >
            <span>{name}</span>
          </motion.button>
        ))}
      </div>
    </nav>
  );
}

export function SectionPreview({ section, onBack }: {
  section: Exclude<WorkbenchSection, "chat">;
  onBack: () => void;
}) {
  const t = useUiText();
  const content = {
    design: { title: t("Una mateixa marca. Moltes idees."), description: t("Presentacions, documents i papers de carta amb la identitat de l’empresa."), note: t("El flux de creació i les plantilles corporatives s’incorporaran en una fase posterior.") },
    excel: { title: t("Menys copiar. Més avançar."), description: t("Unir dades, preparar fórmules i donar forma als teus Excels."), note: t("Les operacions amb fitxers s’incorporaran en una fase posterior.") },
    schedules: { title: t("Un espai per encaixar els horaris."), description: t("Disponibilitats i planificació de les botigues, en un sol lloc."), note: t("Aquest espai encara no rep WhatsApps ni genera horaris.") },
  }[section];
  return (
    <section className={`workbench-section-preview ${styles.preview}`} aria-label={items.find((item) => item.id === section)?.name}>
      <div>
        <h1>{content.title}</h1>
        <p className={styles.description}>{content.description}</p>
        <p className={styles.note}>{t("Pròximament.")}{" "}{content.note}</p>
        <button type="button" className={styles.back} onClick={onBack}>{t("Tornar al xat")}</button>
      </div>
    </section>
  );
}
