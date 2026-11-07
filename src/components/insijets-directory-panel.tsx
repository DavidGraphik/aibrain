"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Airplane, ArrowClockwise, SidebarSimple } from "@phosphor-icons/react";
import { useUiLocale } from "@/i18n/provider";
import { useModalFocus } from "@/ui/use-modal-focus";
import {
  outlookEmails,
  type DirectoryKind,
  type Contact,
  type SourceRecord,
  type DirectoryDataset,
  type browseDirectory,
} from "@/insijets/directory";
import styles from "./insijets-workspaces.module.css";
type Browse = ReturnType<typeof browseDirectory> & {
  revision: number;
  canImport: boolean;
  canExport: boolean;
};
type Item = SourceRecord & {
  contacts?: Contact[];
  bases?: SourceRecord[];
  operatorName?: string | null;
};
const filterNames = [
  "region",
  "country",
  "category",
  "model",
  "city",
  "airport",
  "useType",
  "rating",
] as const;
export function InsiJetsDirectoryPanel({
  onToggleSidebar,
}: {
  onToggleSidebar: () => void;
}) {
  const es = useUiLocale() === "es",
    t = useCallback((en: string, spanish: string) => (es ? spanish : en), [es]);
  const [data, setData] = useState<Browse | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({}),
    [page, setPage] = useState(1),
    [view, setView] = useState<DirectoryKind>("aircraft"),
    [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [detailId, setDetailId] = useState<string | null>(null),
    [pendingImport, setPendingImport] = useState<{
      name: string;
      dataset: DirectoryDataset;
    } | null>(null),
    [exportReview, setExportReview] = useState(false),
    [busy, setBusy] = useState(false);
  const modalRef = useModalFocus<HTMLDivElement>(
    Boolean(pendingImport || exportReview),
    () => {
      if (!busy) {
        setPendingImport(null);
        setExportReview(false);
      }
    },
  );
  const query = useMemo(
    () =>
      new URLSearchParams({
        ...Object.fromEntries(
          Object.entries(filters).filter(([, v]) => v !== ""),
        ),
        page: String(page),
        limit: "50",
        view,
      }).toString(),
    [filters, page, view],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      fetch("/api/insijets/directory?" + query, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (r) => {
          if (!r.ok) throw Error();
          const value: Browse = await r.json();
          if (controller.signal.aborted) return;
          setData(value);
          setSelected(new Set());
          setDetailId(null);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setData(null);
            setError(
              t(
                "The directory is unavailable. Check your access or ask David to configure it.",
                "El directorio no está disponible. Revisa tu acceso o pide a David que lo configure.",
              ),
            );
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, reload, t]);
  const items: Item[] = !data
    ? []
    : view === "aircraft"
      ? data.rows
      : data.records;
  const detail = items.find((r) => r.id === detailId),
    total = data ? (view === "aircraft" ? data.total : data.recordTotal) : 0;
  const contactsFor = (item: Item): Contact[] =>
    view === "contacts" ? [item as Contact] : item.contacts || [];
  const selectedContacts = items
    .filter((i) => selected.has(i.id))
    .flatMap(contactsFor);
  const selectedEmails = outlookEmails(selectedContacts);
  const changeFilter = (key: string, value: string) => {
    setFilters((old) => ({ ...old, [key]: value }));
    setPage(1);
    setSelected(new Set());
  };
  const copy = async (emails: string) => {
    try {
      await navigator.clipboard.writeText(emails);
      setNotice(
        t(
          "Published emails copied for Outlook. Nothing has been sent.",
          "Emails publicados copiados para Outlook. No se ha enviado nada.",
        ),
      );
    } catch {
      setNotice(
        t(
          "Clipboard unavailable. Select and copy the visible addresses.",
          "Portapapeles no disponible. Selecciona y copia las direcciones visibles.",
        ),
      );
    }
  };
  const request = async (operation: string, body: unknown) => {
    const r = await fetch("/api/insijets/directory/" + operation, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const value = await r.json();
      throw Error(value.error || "Request failed");
    }
    return r;
  };
  const exportData = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const r = await request("export", {
        kind: view,
        ids: [...selected],
        expectedRevision: data.revision,
        confirmation: "EXPORT SELECTED PUBLIC DATA",
      });
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `insijets-${view}${data.synthetic ? "-SYNTHETIC" : ""}-r${data.revision}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportReview(false);
      setNotice(
        t(
          "CSV exported with source IDs and provenance.",
          "CSV exportado con IDs y procedencia.",
        ),
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Export unavailable");
    } finally {
      setBusy(false);
    }
  };
  const importData = async () => {
    if (!pendingImport || !data) return;
    setBusy(true);
    try {
      const r = await request("import", {
        dataset: pendingImport.dataset,
        expectedRevision: data.revision,
        confirmation: "IMPORT PUBLIC DIRECTORY",
      });
      const result = await r.json();
      setPendingImport(null);
      setReload((n) => n + 1);
      setNotice(
        result.repeated
          ? t(
              "This exact dataset was already imported.",
              "Este dataset exacto ya estaba importado.",
            )
          : t(
              `Imported: ${result.inserted} new, ${result.updated} updated. Existing records retained.`,
              `Importado: ${result.inserted} nuevos, ${result.updated} actualizados. Registros existentes conservados.`,
            ),
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Import unavailable");
    } finally {
      setBusy(false);
    }
  };
  const name = (r: Item) =>
    String(
      view === "aircraft"
        ? r.model || t("Model not published", "Modelo no publicado")
        : view === "operators"
          ? r.name
          : view === "contacts"
            ? r.email
            : view === "bases"
              ? r.airport || r.city || r.id
              : r.region || r.id,
    );
  const label = (key: string) =>
    ({
      region: t("Region", "Región"),
      country: t("Country", "País"),
      category: t("Category", "Categoría"),
      model: t("Model", "Modelo"),
      city: t("City", "Ciudad"),
      airport: t("Airport", "Aeropuerto"),
      useType: t("Use type", "Uso"),
      rating: t("Published rating", "Rating publicado"),
    })[key] ||
    {
      id: t("Source ID", "ID fuente"),
      operatorId: t("Operator source ID", "ID fuente del operador"),
      baseId: t("Base source ID", "ID fuente de la base"),
      aircraftId: t("Aircraft source ID", "ID fuente de la aeronave"),
      checkedAt: t("Checked (UTC)", "Comprobado (UTC)"),
      registration: t("Registration", "Matrícula"),
      seats: t("Seats", "Plazas"),
      listingOperatorName: t("Name in listing", "Nombre en listado"),
      profileCountry: t("Country on profile", "País en perfil"),
      discrepancy: t("Source discrepancy", "Discrepancia de fuente"),
      published: t("Publicly published", "Publicado públicamente"),
      professional: t("Professional contact", "Contacto profesional"),
      scope: t("Contact scope", "Alcance del contacto"),
    }[key] ||
    key.replace(/([a-z])([A-Z])/g, "$1 $2");
  const missing = t("Not published", "No publicado");
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
        <Airplane size={26} />
        <div>
          <p className={styles.eyebrow}>InsiJets</p>
          <h1>{t("Operator directory", "Directorio de operadores")}</h1>
          <p className={styles.subtitle}>
            Air Charter Guide ·{" "}
            {t(
              "Public professional information",
              "Información profesional pública",
            )}
          </p>
        </div>
        <span className={styles.spacer} />
        <button
          className={styles.button}
          onClick={() => setReload((n) => n + 1)}
        >
          <ArrowClockwise size={15} />
          {t("Reload", "Recargar")}
        </button>
      </header>
      <div className={styles.body}>
        {loading && (
          <p role="status" className={styles.status}>
            {t("Loading directory…", "Cargando directorio…")}
          </p>
        )}
        {error && (
          <div role="alert" className={styles.empty}>
            <h2>{t("Directory unavailable", "Directorio no disponible")}</h2>
            <p>{error}</p>
          </div>
        )}
        {data && (
          <>
            <div className={styles.banner}>
              <strong>
                {data.synthetic
                  ? t("SYNTHETIC TEST DATA", "DATOS SINTÉTICOS DE PRUEBA")
                  : t("Partial coverage", "Cobertura parcial")}
              </strong>{" "}
              ·{" "}
              {data.synthetic
                ? t(
                    "Invented examples for validation. These are not Air Charter Guide records.",
                    "Ejemplos inventados para validación. No son registros de Air Charter Guide.",
                  )
                : t(
                    "Only imported source records are shown. Worldwide extraction is not confirmed complete.",
                    "Sólo se muestran registros importados. La extracción mundial no está confirmada como completa.",
                  )}
            </div>
            <div className={styles.stats}>
              {[
                [data.counts.aircraft, t("Aircraft", "Aeronaves")],
                [data.counts.operators, t("Operators", "Operadores")],
                [
                  data.counts.uniqueEmails,
                  t("Unique published emails", "Emails publicados únicos"),
                ],
                [
                  data.counts.aircraftWithoutEmails,
                  t(
                    "Aircraft without published email",
                    "Aeronaves sin email publicado",
                  ),
                ],
              ].map(([n, l]) => (
                <div className={styles.stat} key={l}>
                  <strong>{n}</strong>
                  <span>{l}</span>
                </div>
              ))}
            </div>
            <div
              className={styles.tabs}
              role="tablist"
              aria-label={t("Directory sections", "Secciones del directorio")}
            >
              {(
                [
                  ["aircraft", t("Aircraft", "Aeronaves")],
                  ["operators", t("Operators", "Operadores")],
                  ["bases", t("Bases", "Bases")],
                  ["contacts", t("Contacts", "Contactos")],
                  ["coverage", t("Coverage", "Cobertura")],
                ] as [DirectoryKind, string][]
              ).map(([key, title], index, tabs) => (
                <button
                  key={key}
                  role="tab"
                  id={"directory-tab-" + key}
                  aria-controls="directory-results"
                  aria-selected={view === key}
                  tabIndex={view === key ? 0 : -1}
                  className={styles.tab}
                  onKeyDown={(e) => {
                    if (
                      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        e.key,
                      )
                    )
                      return;
                    e.preventDefault();
                    const next =
                      e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? tabs.length - 1
                          : (index +
                              (e.key === "ArrowRight" ? 1 : -1) +
                              tabs.length) %
                            tabs.length;
                    setView(tabs[next][0]);
                    setPage(1);
                    document
                      .getElementById("directory-tab-" + tabs[next][0])
                      ?.focus();
                  }}
                  onClick={() => {
                    setView(key);
                    setPage(1);
                    setSelected(new Set());
                  }}
                >
                  {title}
                </button>
              ))}
            </div>
            <div className={styles.filters}>
              <label className={styles.field}>
                {t("Search", "Buscar")}
                <input
                  type="search"
                  placeholder={t(
                    "Operator, model, city…",
                    "Operador, modelo, ciudad…",
                  )}
                  value={filters.query || ""}
                  onChange={(e) => changeFilter("query", e.target.value)}
                />
              </label>
              {filterNames.slice(0, 4).map((key) => (
                <label className={styles.field} key={key}>
                  {label(key)}
                  <select
                    aria-label={label(key)}
                    value={filters[key] || ""}
                    onChange={(e) => changeFilter(key, e.target.value)}
                  >
                    <option value="">{t("All", "Todos")}</option>
                    {(data.facets[key] || []).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <details>
              <summary className={styles.subtitle}>
                {t("More filters", "Más filtros")}
              </summary>
              <div className={styles.moreFilters}>
                {filterNames.slice(4).map((key) => (
                  <label className={styles.field} key={key}>
                    {label(key)}
                    <select
                      aria-label={label(key)}
                      value={filters[key] || ""}
                      onChange={(e) => changeFilter(key, e.target.value)}
                    >
                      <option value="">{t("All", "Todos")}</option>
                      {(data.facets[key] || []).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                ))}
                <label className={styles.field}>
                  {t("Minimum seats", "Plazas mínimas")}
                  <input
                    aria-label={t("Minimum seats", "Plazas mínimas")}
                    type="number"
                    min="0"
                    max="1000"
                    value={filters.minSeats || ""}
                    onChange={(e) => changeFilter("minSeats", e.target.value)}
                  />
                </label>
              </div>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={filters.hasEmail === "true"}
                  onChange={(e) =>
                    changeFilter("hasEmail", e.target.checked ? "true" : "")
                  }
                />
                {t(
                  "Only with published professional email",
                  "Sólo con email profesional publicado",
                )}
              </label>
            </details>
            <div className={styles.toolbar}>
              <p>
                {total} {t("results", "resultados")} · {selected.size}{" "}
                {t("selected", "seleccionados")}
              </p>
              <button
                className={styles.button}
                onClick={() => {
                  setFilters({});
                  setPage(1);
                }}
              >
                {t("Clear filters", "Limpiar filtros")}
              </button>
              <span className={styles.spacer} />
              <button
                className={styles.button}
                disabled={!selectedEmails || loading}
                onClick={() => void copy(selectedEmails)}
              >
                {t("Copy emails for Outlook", "Copiar emails para Outlook")}
              </button>
              {data.canExport && (
                <button
                  className={styles.button}
                  disabled={!selected.size || loading}
                  onClick={() => setExportReview(true)}
                >
                  {t("Export selected CSV", "Exportar selección CSV")}
                </button>
              )}
              {data.canImport && (
                <label className={styles.button}>
                  {t("Review import", "Revisar importación")}
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="sr-only"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      try {
                        if (file.size > 8 * 1024 * 1024)
                          throw Error(
                            t(
                              "Maximum file size: 8 MiB",
                              "Tamaño máximo: 8 MiB",
                            ),
                          );
                        const d = JSON.parse(await file.text());
                        if (
                          d.schemaVersion !== 1 ||
                          !Array.isArray(d.aircraft) ||
                          !Array.isArray(d.operators)
                        )
                          throw Error(
                            t(
                              "Use the directory JSON format",
                              "Usa el formato JSON del directorio",
                            ),
                          );
                        setPendingImport({ name: file.name, dataset: d });
                      } catch (err) {
                        setNotice(
                          err instanceof Error ? err.message : "Invalid file",
                        );
                      }
                    }}
                  />
                </label>
              )}
            </div>
            {notice && (
              <p role="status" className={styles.status}>
                {notice}
              </p>
            )}
            {selectedEmails && (
              <p
                className={styles.subtitle}
                style={{ overflowWrap: "anywhere", marginBottom: 12 }}
              >
                {selectedEmails}
              </p>
            )}
            <section
              id="directory-results"
              role="tabpanel"
              aria-labelledby={"directory-tab-" + view}
              aria-busy={loading}
              className={styles.layout}
            >
              {!items.length ? (
                <div className={styles.empty}>
                  <h2>
                    {t(
                      "No source records yet",
                      "Todavía no hay registros fuente",
                    )}
                  </h2>
                  <p>
                    {t(
                      "Import a verified public checkpoint, or adjust the filters.",
                      "Importa un checkpoint público verificado o ajusta los filtros.",
                    )}
                  </p>
                </div>
              ) : (
                <div>
                  <div className={styles.list}>
                    {items.map((item) => (
                      <div className={styles.row} key={item.id}>
                        <input
                          type="checkbox"
                          aria-label={t("Select ", "Seleccionar ") + name(item)}
                          checked={selected.has(item.id)}
                          disabled={loading}
                          onChange={(e) =>
                            setSelected((old) => {
                              const next = new Set(old);
                              if (e.target.checked) next.add(item.id);
                              else next.delete(item.id);
                              return next;
                            })
                          }
                        />
                        <button
                          className={styles.record}
                          aria-pressed={detailId === item.id}
                          onClick={() => setDetailId(item.id)}
                        >
                          <span>
                            <strong>{name(item)}</strong>
                            <small>
                              {view === "aircraft"
                                ? [
                                    String(
                                      (item.operator as { name: string }).name,
                                    ),
                                    String(
                                      (item.base as { city?: string }).city ||
                                        missing,
                                    ),
                                    item.seats == null
                                      ? missing
                                      : String(item.seats) +
                                        t(" seats", " plazas"),
                                  ].join(" · ")
                                : String(
                                    item.operatorName ||
                                      item.category ||
                                      item.id,
                                  )}
                            </small>
                          </span>
                          <span className={styles.badge}>
                            {view === "coverage"
                              ? String(item.status)
                              : contactsFor(item).length
                                ? t("Published email", "Email publicado")
                                : t("No email", "Sin email")}
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className={styles.page}>
                    <button
                      className={styles.button}
                      disabled={page === 1 || loading}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      {t("Previous", "Anterior")}
                    </button>
                    <span>
                      {page} / {Math.max(1, Math.ceil(total / 50))}
                    </span>
                    <button
                      className={styles.button}
                      disabled={page * 50 >= total || loading}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      {t("Next", "Siguiente")}
                    </button>
                  </div>
                </div>
              )}
              <aside className={styles.detail}>
                {!detail ? (
                  <>
                    <h2>{t("Source details", "Detalles de la fuente")}</h2>
                    <p>
                      {t(
                        "Choose a record to inspect its operator, base, contacts and provenance.",
                        "Elige un registro para revisar operador, base, contactos y procedencia.",
                      )}
                    </p>
                    <p>
                      {data.counts.repeatedEmails}{" "}
                      {t(
                        "repeated email occurrences retained",
                        "ocurrencias de email repetidas conservadas",
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <p className={styles.eyebrow}>
                      {t("Source record", "Registro fuente")}
                    </p>
                    <h2>{name(detail)}</h2>
                    <dl>
                      {Object.entries(detail)
                        .filter(
                          ([key, value]) =>
                            ![
                              "contacts",
                              "bases",
                              "operator",
                              "base",
                              "sourceURL",
                            ].includes(key) &&
                            value != null &&
                            typeof value !== "object",
                        )
                        .map(([key, value]) => (
                          <div key={key} style={{ display: "contents" }}>
                            <dt>{label(key)}</dt>
                            <dd>
                              {key === "checkedAt"
                                ? new Intl.DateTimeFormat(
                                    es ? "es-ES" : "en-GB",
                                    {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                      timeZone: "UTC",
                                    },
                                  ).format(new Date(String(value)))
                                : String(value)}
                            </dd>
                          </div>
                        ))}
                    </dl>
                    {view === "aircraft" && (
                      <>
                        <h3>{t("Operator & base", "Operador y base")}</h3>
                        <p>
                          {String((detail.operator as { name: string }).name)}
                          <br />
                          {[
                            (detail.base as SourceRecord).country,
                            (detail.base as SourceRecord).city,
                            (detail.base as SourceRecord).airport,
                          ]
                            .filter(Boolean)
                            .join(" · ") || missing}
                        </p>
                        <a
                          className={styles.source}
                          href={(detail.operator as SourceRecord).sourceURL}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("Operator source", "Fuente del operador")}
                        </a>
                        <a
                          className={styles.source}
                          href={(detail.base as SourceRecord).sourceURL}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("Base source", "Fuente de la base")}
                        </a>
                      </>
                    )}
                    {detail.bases?.map((b) => (
                      <p key={b.id}>
                        {[b.country, b.city, b.airport]
                          .filter(Boolean)
                          .join(" · ")}
                        <a
                          className={styles.source}
                          href={b.sourceURL}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {b.id}
                        </a>
                      </p>
                    ))}
                    <h3>
                      {t(
                        "Published professional contacts",
                        "Contactos profesionales publicados",
                      )}
                    </h3>
                    {contactsFor(detail).length ? (
                      contactsFor(detail).map((c) => (
                        <p key={c.id}>
                          {c.email}
                          <br />
                          <small>
                            {c.aircraftId
                              ? t("Aircraft contact", "Contacto de aeronave")
                              : c.baseId
                                ? t("Base contact", "Contacto de base")
                                : c.scope === "company"
                                  ? t("Company contact", "Contacto de empresa")
                                  : t(
                                      "Contact scope unconfirmed",
                                      "Alcance del contacto sin confirmar",
                                    )}
                          </small>
                          <a
                            className={styles.source}
                            href={c.sourceURL}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("Contact source", "Fuente del contacto")}
                          </a>
                        </p>
                      ))
                    ) : (
                      <p>{missing}</p>
                    )}
                    {contactsFor(detail).length > 0 && (
                      <button
                        className={styles.button}
                        onClick={() =>
                          void copy(outlookEmails(contactsFor(detail)))
                        }
                      >
                        {t("Copy published emails", "Copiar emails publicados")}
                      </button>
                    )}
                    <a
                      className={styles.source}
                      href={detail.sourceURL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("Open original source", "Abrir fuente original")}
                    </a>
                  </>
                )}
              </aside>
            </section>
          </>
        )}
      </div>
      {(pendingImport || exportReview) && (
        <div
          ref={modalRef}
          tabIndex={-1}
          className={styles.modal}
          role="dialog"
          aria-modal="true"
          aria-label={t("Review selected data", "Revisar datos seleccionados")}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) {
              setPendingImport(null);
              setExportReview(false);
            }
          }}
        >
          <article>
            <h2>
              {pendingImport
                ? t(
                    "Review public directory import",
                    "Revisar importación pública",
                  )
                : t("Review CSV export", "Revisar exportación CSV")}
            </h2>
            {pendingImport ? (
              <>
                <p>{pendingImport.name}</p>
                <p>
                  {pendingImport.dataset.aircraft.length}{" "}
                  {t("aircraft", "aeronaves")} ·{" "}
                  {pendingImport.dataset.operators.length}{" "}
                  {t("operators", "operadores")}
                </p>
                <p>
                  {t(
                    "Only reviewed public source data. Existing records and previous versions are preserved; missing rows are not deleted.",
                    "Sólo datos fuente públicos revisados. Se conservan registros y versiones anteriores; no se borran filas ausentes.",
                  )}
                </p>
                {pendingImport.dataset.synthetic && (
                  <p className={styles.banner}>
                    {t(
                      "Synthetic data requires an isolated test store. Production rejects it.",
                      "Los datos sintéticos requieren un almacén aislado. Producción los rechaza.",
                    )}
                  </p>
                )}
              </>
            ) : (
              <>
                <p>
                  {selected.size}{" "}
                  {t(
                    "selected source records",
                    "registros fuente seleccionados",
                  )}{" "}
                  · {view} · r{data?.revision}
                </p>
                <p>
                  {t(
                    "CSV for Excel, including source IDs, source URL, check date and original record. This does not approve outreach or send anything.",
                    "CSV para Excel con IDs, URL fuente, fecha de comprobación y registro original. No aprueba outreach ni envía nada.",
                  )}
                </p>
                <p style={{ overflowWrap: "anywhere" }}>
                  {[...selected].join(", ")}
                </p>
              </>
            )}
            <footer>
              <button
                autoFocus
                className={styles.button}
                disabled={busy}
                onClick={() => {
                  setPendingImport(null);
                  setExportReview(false);
                }}
              >
                {t("Cancel", "Cancelar")}
              </button>
              <button
                className={styles.primary}
                disabled={busy}
                onClick={() =>
                  void (pendingImport ? importData() : exportData())
                }
              >
                {busy
                  ? t("Processing…", "Procesando…")
                  : pendingImport
                    ? t("Import reviewed data", "Importar datos revisados")
                    : t("Download selected CSV", "Descargar selección CSV")}
              </button>
            </footer>
          </article>
        </div>
      )}
    </main>
  );
}
