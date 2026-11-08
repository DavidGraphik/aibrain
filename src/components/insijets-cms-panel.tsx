"use client";
import { useUiLocale } from "@/i18n/provider";
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Globe, SidebarSimple } from "@phosphor-icons/react";
import styles from "./insijets-workspaces.module.css";
import { InsiJetsPriceIndex, type InsiJetsPriceRecord } from "./insijets-price-index";
type RecordSummary = InsiJetsPriceRecord;
const locales = ["en", "it", "es", "fr", "de", "ar"];
const labels: Record<string, string> = {
  aircraft: "Aircraft models",
  airport: "Airports",
  manufacturer: "Manufacturers",
  category: "Categories",
  charter: "Charter services",
  service: "Charter services",
  legal: "Legal pages",
  listing: "Aircraft listings",
  route: "Routes",
  price: "Prices",
  post: "Articles",
  faq: "FAQs",
  author: "Authors",
  image: "Images",
  page: "Pages",
};
export function InsiJetsCMSPanel({
  onToggleSidebar,
  onDirtyChange,
  onRequestChat,
  mode = "content",
}: {
  onToggleSidebar: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onRequestChat?: (prompt: string) => void;
  mode?: "content" | "pricing";
}) {
  const es = useUiLocale() === "es",
    t = (en: string, spanish: string) => (es ? spanish : en);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading"),
    [attempt, setAttempt] = useState(0),
    [records, setRecords] = useState<RecordSummary[]>([]);
  const [locale, setLocale] = useState("en"),
    [family, setFamily] = useState(mode === "pricing" ? "route" : ""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [selected, setSelected] = useState<RecordSummary | null>(null),
    [frameEpoch, setFrameEpoch] = useState(0),
    [message, setMessage] = useState(""),
    [pricingEditor, setPricingEditor] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null),
    dirty = useRef(false),
    selecting = useRef(false),
    detach = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/insijets/cms/api/auth/session", {
        cache: "no-store",
        signal: controller.signal,
      }),
      fetch("/api/insijets/cms/api/admin/content", {
        cache: "no-store",
        signal: controller.signal,
      }),
    ])
      .then(async ([s, c]) => {
        if (!s.ok || !c.ok || !(await s.json()).user) throw Error();
        const value = await c.json();
        if (!Array.isArray(value.records)) throw Error();
        if (controller.signal.aborted) return;
        setRecords(
          value.records.map(
            ({ id, title, type, locale, status, revision, data, updated_at }: RecordSummary) => ({
              id,
              title,
              type,
              locale,
              status,
              revision,
              data,
              updated_at,
            }),
          ),
        );
        setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      detach.current();
      window.removeEventListener("beforeunload", leave);
      onDirtyChange?.(false);
    };
  }, [onDirtyChange]);
  // Reuse the original same-origin editor. No fields, save logic or data store are duplicated.
  useEffect(() => {
    if (state !== "ready" || !selected) return;
    let document: Document | null;
    try {
      document = iframe.current?.contentDocument || null;
    } catch {
      return;
    }
    if (!document?.body) return;
    const doc = document;
    const activate = () => {
      const localeSelect = doc.getElementById(
        "cms-locale",
      ) as HTMLSelectElement | null;
      if (!localeSelect) return false;
      selecting.current = true;
      try {
        if (localeSelect.value !== locale) {
          localeSelect.value = locale;
          localeSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const typeSelect = doc.querySelector<HTMLSelectElement>(
          '#cms-editor [name="type"]',
        );
        if (
          selected.type &&
          typeSelect &&
          !Array.from(typeSelect.options).some((o) => o.value === selected.type)
        ) {
          const option = doc.createElement("option");
          option.value = selected.type;
          option.textContent = labels[selected.type] || selected.type;
          typeSelect.append(option);
        }
        if (selected.id) {
          const button = Array.from(
            doc.querySelectorAll<HTMLButtonElement>("[data-record]"),
          ).find((b) => b.dataset.record === selected.id);
          if (!button) return false;
          button.click();
        } else {
          const button = doc.getElementById("cms-new");
          if (!button) return false;
          button.click();
          if (selected.type) {
            const type = doc.querySelector<HTMLSelectElement>(
              '#cms-editor [name="type"]',
            );
            if (
              type &&
              Array.from(type.options).some((o) => o.value === selected.type)
            ) {
              type.value = selected.type;
              type.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
        }
        dirty.current = false;
        onDirtyChange?.(false);
        return true;
      } finally {
        selecting.current = false;
      }
    };
    if (activate()) return;
    const observer = new MutationObserver(() => {
      if (activate()) observer.disconnect();
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [selected, locale, frameEpoch, state, onDirtyChange]);
  const discard = () =>
    !dirty.current ||
    window.confirm(
      t(
        "Discard unsaved changes in the current record?",
        "¿Descartar los cambios sin guardar del registro actual?",
      ),
    );
  const choose = (record: RecordSummary) => {
    if (!discard()) return;
    dirty.current = false;
    setSelected(record);
    setMessage("");
  };
  const switchLocale = (value: string) => {
    if (!discard()) return;
    dirty.current = false;
    setLocale(value);
    const equivalent = selected?.id
      ? records.find((r) => r.id === selected.id && r.locale === value)
      : null;
    setSelected(
      equivalent || {
        id: "",
        title: "",
        type: selected?.type || family,
        locale: value,
        status: "draft",
        revision: 0,
      },
    );
    setMessage(
      selected?.id && !equivalent
        ? t(
            "This record has no version in the selected language. Choose or create a record in that language.",
            "Este registro no tiene versión en el idioma seleccionado. Elige o crea un registro en ese idioma.",
          )
        : "",
    );
  };
  const scopedRecords = mode === "pricing" ? records.filter((r) => r.type === "route" || r.type === "price") : records;
  const families = [...new Set(scopedRecords.map((r) => r.type))].sort();
  const visible = scopedRecords.filter(
    (r) =>
      r.locale === locale &&
      (!family || r.type === family) &&
      (!status || r.status === status) &&
      [r.title, r.id, r.type]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  if (mode === "pricing" && !pricingEditor) return <InsiJetsPriceIndex
    records={records}
    state={state}
    onToggleSidebar={onToggleSidebar}
    onRequestChat={onRequestChat}
    onReload={() => { setState("loading"); setAttempt(n => n + 1); }}
    onEditSource={record => { choose(record); setLocale(record.locale); setFamily(record.type); setPricingEditor(true); }}
  />;
  return (
    <main className={styles.panel}>
      <header className={styles.header}>
        <button
          className={styles.button}
          onClick={onToggleSidebar}
          aria-label={t("Show sidebar", "Mostrar barra lateral")}
        >
          <SidebarSimple size={20} />
        </button>
        {mode === "pricing" && <button type="button" className={styles.button} onClick={() => {
          if (!discard()) return;
          dirty.current = false;
          onDirtyChange?.(false);
          detach.current();
          setSelected(null);
          setPricingEditor(false);
        }}>{t("Back to comparisons", "Volver a comparar")}</button>}
        <Globe size={25} />
        <div>
          <p className={styles.eyebrow}>InsiJets · Website</p>
          <h1>{mode === "pricing" ? t("Price Index", "Índice de precios") : t("Website content", "Contenido de la web")}</h1>
          <p className={styles.subtitle}>
            {t(
              mode === "pricing" ? "Routes, prices, currency & review dates" : "Content, images, relationships & version history",
              mode === "pricing" ? "Rutas, precios, moneda y fechas de revisión" : "Contenido, imágenes, relaciones e historial",
            )}{" "}
            · EN / IT / ES / FR / DE / AR
          </p>
        </div>
        <span className={styles.spacer} />
        <button
          className={styles.button}
          onClick={() => {
            if (discard()) {
              dirty.current = false;
              setState("loading");
              setAttempt((n) => n + 1);
            }
          }}
        >
          <ArrowClockwise size={15} />
          {t("Reload", "Recargar")}
        </button>
      </header>
      {state === "loading" && (
        <p role="status" className={styles.body}>
          {t("Connecting to the content editor…", "Conectando con el editor…")}
        </p>
      )}
      {state === "error" && (
        <div className={styles.body}>
          <div role="alert" className={styles.empty}>
            <h2>
              {t("CMS connection unavailable", "Conexión CMS no disponible")}
            </h2>
            <p>
              {t(
                "The website connection or your editor access needs review. Reload after the paired services are configured.",
                "Hay que revisar la conexión con la web o tu acceso como editor. Recarga cuando estén configurados ambos servicios.",
              )}
            </p>
          </div>
        </div>
      )}
      {state === "ready" && (
        <div className={styles.cmsLayout}>
          <aside
            className={styles.catalog}
            aria-label={t("Content selector", "Selector de contenido")}
          >
            <label className={styles.field}>
              {t("Language", "Idioma")}
              <select
                aria-label={t("Language", "Idioma")}
                value={locale}
                onChange={(e) => switchLocale(e.target.value)}
              >
                {locales.map((l) => (
                  <option key={l} value={l}>
                    {l.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              {t("Content family", "Familia de contenido")}
              <select
                aria-label={t("Content family", "Familia de contenido")}
                value={family}
                onChange={(e) => setFamily(e.target.value)}
              >
                <option value="">
                  {mode === "pricing" ? t("Routes and prices", "Rutas y precios") : t("All families", "Todas las familias")}
                </option>
                {families.map((f) => (
                  <option key={f} value={f}>
                    {labels[f] || f}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              {t("Search records", "Buscar registros")}
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Name or source ID…", "Nombre o ID fuente…")}
              />
            </label>
            <label className={styles.field}>
              {t("Status", "Estado")}
              <select
                aria-label={t("Status", "Estado")}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">
                  {t("All statuses", "Todos los estados")}
                </option>
                {[...new Set(scopedRecords.map((r) => r.status))].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <button
              className={styles.button}
              onClick={() =>
                choose({
                  id: "",
                  title: "",
                  type: family,
                  locale,
                  status: "draft",
                  revision: 0,
                })
              }
            >
              {t("Create record", "Crear registro")}
            </button>
            <p className={styles.status}>
              {visible.length} {t("records", "registros")}
            </p>
            <div className={styles.catalogList}>
              {(mode === "pricing" ? visible.slice(0, 24) : visible).map((r) => (
                <button
                  className={styles.record}
                  key={r.id + ":" + r.locale}
                  aria-pressed={selected?.id === r.id}
                  onClick={() => choose(r)}
                >
                  <strong>{r.title}</strong>
                  <small>
                    {labels[r.type] || r.type} · {r.status} · r{r.revision}
                  </small>
                </button>
              ))}
            </div>
            {mode === "pricing" && visible.length > 24 && <p className={styles.subtitle}>{t("Showing the first 24 source records. Search to narrow the list.", "Se muestran los primeros 24 registros fuente. Usa la búsqueda para acotar.")}</p>}
            {!visible.length && (
              <p className={styles.subtitle}>
                {t("No matching records", "Sin registros coincidentes")}
              </p>
            )}
          </aside>
          <section className={styles.editor}>
            <p role="status" className={styles.editorNotice}>
              {message ||
                t(
                  "Edits, images, relations and restore use the website's original editor and database. Saving a draft does not publish it.",
                  "Edición, imágenes, relaciones y restauración usan el editor y la base originales de la web. Guardar un borrador no lo publica.",
                )}
            </p>
            <iframe
              ref={iframe}
              key={attempt}
              title={mode === "pricing" ? "InsiJets Price Index editor" : "InsiJets website CMS"}
              src="/api/insijets/cms/admin"
              referrerPolicy="no-referrer"
              onLoad={() => {
                detach.current();
                const doc = iframe.current?.contentDocument;
                if (!doc?.getElementById("cms-editor")) {
                  setState("error");
                  return;
                }
                const style = doc.createElement("style");
                style.textContent =
                  ".brain-cms-shell .app-grid{grid-template-columns:minmax(0,1fr)}.brain-cms-shell .app-grid>aside{display:none}";
                doc.head.append(style);
                const track = (event: Event) => {
                  if (
                    !selecting.current &&
                    doc
                      .getElementById("cms-editor")
                      ?.contains(event.target as Node)
                  ) {
                    dirty.current = true;
                    onDirtyChange?.(true);
                  }
                };
                doc.addEventListener("input", track);
                doc.addEventListener("change", track);
                let lastSave = "";
                const observer = new MutationObserver(() => {
                  const text =
                    doc.querySelector("#cms-editor .app-status")?.textContent ||
                    "";
                  const identity = [
                    doc.querySelector<HTMLInputElement>(
                      '#cms-editor [name="id"]',
                    )?.value,
                    doc.querySelector<HTMLSelectElement>(
                      '#cms-editor [name="locale"]',
                    )?.value,
                    text,
                  ].join("|");
                  if (
                    /(?:Saved|Restored).*Revision \d+/.test(text) &&
                    identity !== lastSave
                  ) {
                    lastSave = identity;
                    dirty.current = false;
                    onDirtyChange?.(false);
                    fetch("/api/insijets/cms/api/admin/content", {
                      cache: "no-store",
                    })
                      .then((r) => (r.ok ? r.json() : null))
                      .then((value) => {
                        if (value?.records)
                          setRecords(
                            value.records.map(
                              ({
                                id,
                                title,
                                type,
                                locale,
                                status,
                                revision,
                                data,
                                updated_at,
                              }: RecordSummary) => ({
                                id,
                                title,
                                type,
                                locale,
                                status,
                                revision,
                                data,
                                updated_at,
                              }),
                            ),
                          );
                      })
                      .catch(() => {});
                  }
                });
                observer.observe(doc.getElementById("cms-editor")!, {
                  childList: true,
                  subtree: true,
                  characterData: true,
                });
                detach.current = () => {
                  observer.disconnect();
                  doc.removeEventListener("input", track);
                  doc.removeEventListener("change", track);
                };
                setFrameEpoch((n) => n + 1);
              }}
            />
          </section>
        </div>
      )}
    </main>
  );
}
