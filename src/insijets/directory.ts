export const DIRECTORY_KINDS = [
  "operators",
  "bases",
  "aircraft",
  "contacts",
  "coverage",
] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];
export type SourceRecord = {
  id: string;
  sourceURL: string;
  checkedAt: string;
  [key: string]: unknown;
};
export type Operator = SourceRecord & { name: string; aliases?: string[] };
export type Base = SourceRecord & {
  operatorId: string;
  region?: string | null;
  country?: string | null;
  city?: string | null;
  airport?: string | null;
};
export type Aircraft = SourceRecord & {
  operatorId: string;
  baseId: string;
  model?: string | null;
  category?: string | null;
  seats?: number | null;
  useType?: string | null;
  rating?: string | null;
  registration?: string | null;
};
export type Contact = SourceRecord & {
  operatorId: string;
  baseId?: string | null;
  aircraftId?: string | null;
  email: string;
  published: true;
  professional: true;
  scope?: "company" | "unknown";
};
export type Coverage = SourceRecord & {
  region?: string | null;
  category?: string | null;
  status: "partial" | "complete" | "pending";
  reportedTotal?: number | null;
};
export type DirectoryDataset = {
  schemaVersion: 1;
  source: "air-charter-guide";
  synthetic: boolean;
  operators: Operator[];
  bases: Base[];
  aircraft: Aircraft[];
  contacts: Contact[];
  coverage: Coverage[];
};
export type DirectoryFilters = {
  query?: string;
  region?: string;
  country?: string;
  city?: string;
  airport?: string;
  model?: string;
  category?: string;
  useType?: string;
  rating?: string;
  minSeats?: number;
  hasEmail?: boolean;
  page?: number;
  limit?: number;
  view?: DirectoryKind;
};
export class DirectoryError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function required(
  value: unknown,
  name: string,
  max = 300,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new DirectoryError(`Invalid ${name}`);
}
const optionalText = (row: SourceRecord, key: string) => {
  if (
    row[key] != null &&
    (typeof row[key] !== "string" ||
      (row[key] as string).length > 1000 ||
      /[\u0000-\u001f\u007f]/.test(row[key] as string))
  )
    throw new DirectoryError(`Invalid ${key}`);
};
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJSON).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalJSON((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function emptyDirectory(synthetic = false): DirectoryDataset {
  return {
    schemaVersion: 1,
    source: "air-charter-guide",
    synthetic,
    operators: [],
    bases: [],
    aircraft: [],
    contacts: [],
    coverage: [],
  };
}
export function validateDirectory(
  value: unknown,
  allowSynthetic = false,
): DirectoryDataset {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DirectoryError("Expected a directory dataset");
  const d = value as DirectoryDataset;
  if (
    d.schemaVersion !== 1 ||
    d.source !== "air-charter-guide" ||
    typeof d.synthetic !== "boolean" ||
    (d.synthetic && !allowSynthetic)
  )
    throw new DirectoryError("Unsupported or synthetic source");
  if (
    Object.keys(d).some(
      (k) =>
        !["schemaVersion", "source", "synthetic", ...DIRECTORY_KINDS].includes(
          k,
        ),
    )
  )
    throw new DirectoryError("Unknown dataset field");
  let total = 0;
  for (const kind of DIRECTORY_KINDS) {
    if (!Array.isArray(d[kind])) throw new DirectoryError(`Missing ${kind}`);
    total += d[kind].length;
    if (total > 25000)
      throw new DirectoryError("Import exceeds 25000 records", 413);
    const ids = new Set<string>();
    for (const row of d[kind]) {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new DirectoryError(`Invalid ${kind} row`);
      required(row.id, "source id", 200);
      required(row.sourceURL, "source URL", 2000);
      required(row.checkedAt, "checkedAt", 40);
      if (ids.has(row.id))
        throw new DirectoryError(`Duplicate source id in ${kind}`);
      ids.add(row.id);
      if (
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.checkedAt) ||
        !Number.isFinite(Date.parse(row.checkedAt)) ||
        new Date(row.checkedAt).toISOString().slice(0, 19) !==
          row.checkedAt.slice(0, 19) ||
        Date.parse(row.checkedAt) > Date.now() + 300000
      )
        throw new DirectoryError("Invalid checkedAt timestamp");
      let url: URL;
      try {
        url = new URL(row.sourceURL);
      } catch {
        throw new DirectoryError("Invalid source URL");
      }
      const hosts = d.synthetic
        ? ["example.invalid"]
        : ["aircharterguide.com", "www.aircharterguide.com"];
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !hosts.includes(url.hostname)
      )
        throw new DirectoryError(
          "Source must be a public Air Charter Guide page",
        );
      for (const k of [
        "region",
        "country",
        "city",
        "airport",
        "model",
        "category",
        "useType",
        "rating",
        "registration",
        "name",
        "operatorId",
        "baseId",
        "aircraftId",
      ])
        optionalText(row, k);
      if (kind === "operators") {
        required(row.name, "operator name");
        if (
          row.aliases !== undefined &&
          (!Array.isArray(row.aliases) ||
            row.aliases.some((v) => typeof v !== "string" || v.length > 300))
        )
          throw new DirectoryError("Invalid aliases");
      }
      if (["bases", "aircraft", "contacts"].includes(kind))
        required(row.operatorId, "operatorId", 200);
      if (kind === "aircraft") {
        required(row.baseId, "baseId", 200);
        if (
          row.seats != null &&
          (!Number.isInteger(row.seats) ||
            (row.seats as number) < 0 ||
            (row.seats as number) > 1000)
        )
          throw new DirectoryError("Invalid seats");
      }
      if (kind === "contacts") {
        required(row.email, "published email", 254);
        if (
          row.published !== true ||
          row.professional !== true ||
          !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(
            row.email as string,
          ) ||
          (d.synthetic &&
            !(row.email as string).toLowerCase().endsWith(".invalid"))
        )
          throw new DirectoryError(
            "Only published professional emails are accepted",
          );
      }
      if (
        kind === "contacts" &&
        ((row.scope != null &&
          !["company", "unknown"].includes(row.scope as string)) ||
          (!row.baseId &&
            !row.aircraftId &&
            !["company", "unknown"].includes(row.scope as string)) ||
          (row.scope && (row.baseId || row.aircraftId)))
      )
        throw new DirectoryError(
          "Explicit contact scope required when no location/aircraft is supplied",
        );
      if (
        kind === "coverage" &&
        (!["partial", "complete", "pending"].includes(row.status as string) ||
          (row.reportedTotal != null &&
            (!Number.isSafeInteger(row.reportedTotal) ||
              (row.reportedTotal as number) < 0)))
      )
        throw new DirectoryError("Invalid coverage");
    }
  }
  return d;
}
export function validateRelationships(d: DirectoryDataset) {
  const operators = new Set(d.operators.map((r) => r.id)),
    bases = new Map(d.bases.map((r) => [r.id, r])),
    aircraft = new Map(d.aircraft.map((r) => [r.id, r]));
  for (const b of d.bases)
    if (!operators.has(b.operatorId))
      throw new DirectoryError("Base has a missing operator");
  for (const a of d.aircraft)
    if (
      !operators.has(a.operatorId) ||
      bases.get(a.baseId)?.operatorId !== a.operatorId
    )
      throw new DirectoryError(
        "Aircraft has a missing or mismatched operator/base",
      );
  for (const c of d.contacts)
    if (
      !operators.has(c.operatorId) ||
      (c.baseId && bases.get(c.baseId)?.operatorId !== c.operatorId) ||
      (c.aircraftId &&
        (aircraft.get(c.aircraftId)?.operatorId !== c.operatorId ||
          (c.baseId && aircraft.get(c.aircraftId)?.baseId !== c.baseId)))
    )
      throw new DirectoryError(
        "Contact has a missing or mismatched association",
      );
}
export function aircraftContacts(d: DirectoryDataset, a: Aircraft) {
  return d.contacts.filter(
    (c) =>
      c.operatorId === a.operatorId &&
      (c.aircraftId
        ? c.aircraftId === a.id
        : c.baseId
          ? c.baseId === a.baseId
          : c.scope === "company"),
  );
}
export function outlookEmails(contacts: Contact[]) {
  return [
    ...new Map(contacts.map((c) => [c.email.toLowerCase(), c.email])).values(),
  ].join("; ");
}
export function browseDirectory(
  d: DirectoryDataset,
  filters: DirectoryFilters = {},
) {
  const operators = new Map(d.operators.map((r) => [r.id, r])),
    bases = new Map(d.bases.map((r) => [r.id, r]));
  const query = filters.query?.toLowerCase() || "";
  const all = d.aircraft.map((a) => ({
    ...a,
    operator: operators.get(a.operatorId)!,
    base: bases.get(a.baseId)!,
    contacts: aircraftContacts(d, a),
  }));
  const filtered = all.filter((row) => {
    if (
      query &&
      ![
        row.operator.name,
        ...(row.operator.aliases || []),
        row.model,
        row.registration,
        row.base.city,
        row.base.airport,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query)
    )
      return false;
    for (const key of ["region", "country", "city", "airport"] as const)
      if (filters[key] && row.base[key] !== filters[key]) return false;
    for (const key of ["model", "category", "useType", "rating"] as const)
      if (filters[key] && row[key] !== filters[key]) return false;
    return !(
      (filters.minSeats != null &&
        (row.seats == null || row.seats < filters.minSeats)) ||
      (filters.hasEmail && !row.contacts.length)
    );
  });
  const limit = Math.min(100, Math.max(1, filters.limit || 50)),
    page = Math.max(1, filters.page || 1);
  const facets = Object.fromEntries(
    [
      "region",
      "country",
      "city",
      "airport",
      "model",
      "category",
      "useType",
      "rating",
    ].map((key) => [
      key,
      [
        ...new Set(
          all
            .map((r) =>
              ["region", "country", "city", "airport"].includes(key)
                ? r.base[key]
                : (r as unknown as Record<string, unknown>)[key],
            )
            .filter((v): v is string => typeof v === "string" && v.length > 0),
        ),
      ].sort(),
    ]),
  );
  const uniqueEmailCount = new Set(d.contacts.map((c) => c.email.toLowerCase()))
    .size;
  const view = filters.view || "aircraft";
  const hasAircraftFilter = [
    "region",
    "country",
    "city",
    "airport",
    "model",
    "category",
    "useType",
    "rating",
    "minSeats",
    "hasEmail",
  ].some(
    (k) =>
      filters[k as keyof DirectoryFilters] != null &&
      filters[k as keyof DirectoryFilters] !== "",
  );
  const operatorIds = new Set(filtered.map((a) => a.operatorId)),
    baseIds = new Set(filtered.map((a) => a.baseId));
  const visibleContacts = new Set(
    filtered.flatMap((a) => a.contacts.map((c) => c.id)),
  );
  const entities =
    view === "aircraft"
      ? []
      : d[view]
          .filter((r) => {
            if (view === "coverage")
              return (
                (!filters.region || r.region === filters.region) &&
                (!filters.category || r.category === filters.category)
              );
            if (
              hasAircraftFilter &&
              !(view === "operators"
                ? operatorIds.has(r.id)
                : view === "bases"
                  ? baseIds.has(r.id)
                  : visibleContacts.has(r.id))
            )
              return false;
            const name =
              view === "operators"
                ? r.name
                : operators.get(r.operatorId as string)?.name;
            return (
              !query ||
              [
                name,
                r.email,
                r.city,
                r.airport,
                ...(Array.isArray(r.aliases) ? r.aliases : []),
              ]
                .join(" ")
                .toLowerCase()
                .includes(query) ||
              (view === "operators" && operatorIds.has(r.id)) ||
              (view === "bases" && baseIds.has(r.id)) ||
              (view === "contacts" && visibleContacts.has(r.id))
            );
          })
          .map((r) => ({
            ...r,
            operatorName:
              view === "operators" || view === "coverage"
                ? null
                : operators.get(r.operatorId as string)?.name,
            bases:
              view === "operators"
                ? d.bases.filter((b) => b.operatorId === r.id)
                : [],
            contacts:
              view === "operators"
                ? d.contacts.filter((c) => c.operatorId === r.id)
                : view === "bases"
                  ? d.contacts.filter((c) => c.baseId === r.id)
                  : [],
          }));
  return {
    synthetic: d.synthetic,
    source: d.source,
    rows: filtered.slice((page - 1) * limit, page * limit),
    total: filtered.length,
    page,
    limit,
    facets,
    view,
    records: entities.slice((page - 1) * limit, page * limit),
    recordTotal: entities.length,
    coverage: d.coverage,
    counts: {
      aircraft: d.aircraft.length,
      operators: d.operators.length,
      bases: d.bases.length,
      contacts: d.contacts.length,
      uniqueEmails: uniqueEmailCount,
      repeatedEmails: d.contacts.length - uniqueEmailCount,
      aircraftWithoutEmails: all.filter((r) => !r.contacts.length).length,
    },
  };
}
const csvCell = (value: unknown) => {
  const text =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return (
    '"' +
    (/^[\s]*[=+@-]/.test(text) ? "'" : "") +
    text.replace(/"/g, '""') +
    '"'
  );
};
export function exportDirectoryCSV(
  d: DirectoryDataset,
  kind: DirectoryKind,
  ids?: string[],
) {
  const original = d[kind].filter((r) => !ids || ids.includes(r.id));
  const rows: Record<string, unknown>[] = original.map((r) =>
    kind === "aircraft"
      ? {
          ...r,
          operator: d.operators.find((o) => o.id === (r as Aircraft).operatorId)
            ?.name,
          ...Object.fromEntries(
            ["region", "country", "city", "airport"].map((k) => [
              k,
              d.bases.find((b) => b.id === (r as Aircraft).baseId)?.[k] ?? null,
            ]),
          ),
          outlookEmails: outlookEmails(aircraftContacts(d, r as Aircraft)),
          synthetic: d.synthetic,
          originalRecordJSON: JSON.stringify(r),
        }
      : { ...r, synthetic: d.synthetic, originalRecordJSON: JSON.stringify(r) },
  );
  const columns = [
    ...new Set([
      "id",
      "sourceURL",
      "checkedAt",
      ...rows.flatMap((r) => Object.keys(r)),
    ]),
  ];
  return (
    "\uFEFF" +
    [
      columns.map(csvCell).join(","),
      ...rows.map((r) => columns.map((k) => csvCell(r[k])).join(",")),
    ].join("\r\n") +
    "\r\n"
  );
}
