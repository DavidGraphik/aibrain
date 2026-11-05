export type AdvancedArtifactKind = "visualization" | "internal-site";
export type VisualizationChartType = "bar" | "line" | "pie";

export type VisualizationSeries = {
  name: string;
  color: string | null;
};

export type VisualizationRow = {
  label: string;
  values: number[];
};

/**
 * Deliberately small chart grammar. AiBrain renders it itself and never accepts
 * executable Vega/Plotly snippets or arbitrary JavaScript from a turn.
 */
export type VisualizationSpec = {
  chartType: VisualizationChartType;
  title: string;
  xLabel: string | null;
  yLabel: string | null;
  series: VisualizationSeries[];
  rows: VisualizationRow[];
};

export type ArtifactSource = {
  projectId: string;
  threadId: string;
  messageId: string;
  messageSha256: string;
};

export type VisualizationSnapshotContent = {
  kind: "visualization";
  spec: VisualizationSpec;
};

export type InternalSiteSnapshotContent = {
  kind: "internal-site";
  html: string;
};

export type AdvancedArtifactSnapshot = {
  schemaVersion: 1;
  artifactId: string;
  version: number;
  title: string;
  source: ArtifactSource;
  createdAt: string;
  content: VisualizationSnapshotContent | InternalSiteSnapshotContent;
  contentSha256: string;
};

export type ArtifactPublication = {
  version: number;
  publishedAt: string;
  htmlSha256: string;
};

export type AdvancedArtifactSummary = {
  id: string;
  kind: AdvancedArtifactKind;
  title: string;
  projectId: string;
  threadId: string;
  messageId: string;
  createdAt: string;
  updatedAt: string;
  latestVersion: number;
  publishedVersions: number[];
  previewUrl: string;
  downloadHtmlUrl: string;
  downloadZipUrl: string;
  internalSiteUrl: string | null;
};

export type CreateAdvancedArtifactInput = {
  kind: AdvancedArtifactKind;
  title: string;
  threadId: string;
  messageId: string;
  spec?: VisualizationSpec;
  html?: string;
};

export type CreateAdvancedArtifactVersionInput = {
  threadId: string;
  messageId: string;
  spec?: VisualizationSpec;
  html?: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function safeText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum &&
    (allowEmpty || value.trim().length > 0) && !/\p{C}/u.test(value);
}

function safeNullableText(value: unknown, maximum: number) {
  return value === null || safeText(value, maximum);
}

export function isVisualizationSpec(value: unknown): value is VisualizationSpec {
  if (!record(value) || !exactKeys(value, ["chartType", "title", "xLabel", "yLabel", "series", "rows"])) return false;
  if (!(value.chartType === "bar" || value.chartType === "line" || value.chartType === "pie") ||
      !safeText(value.title, 160) || !safeNullableText(value.xLabel, 80) || !safeNullableText(value.yLabel, 80) ||
      !Array.isArray(value.series) || value.series.length < 1 || value.series.length > 8 ||
      !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 50) return false;
  if (value.chartType === "pie" && value.series.length !== 1) return false;
  const seriesLength = value.series.length;
  if (!value.series.every((item) => record(item) && exactKeys(item, ["name", "color"]) &&
      safeText(item.name, 80) && (item.color === null || (typeof item.color === "string" && HEX_COLOR_PATTERN.test(item.color))))) return false;
  const validRows = value.rows.every((row) => record(row) && exactKeys(row, ["label", "values"]) &&
    safeText(row.label, 100) && Array.isArray(row.values) && row.values.length === seriesLength &&
    row.values.every((number) => typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 1_000_000_000));
  if (!validRows) return false;
  return value.chartType !== "pie" || (
    value.rows.every((row) => row.values[0] >= 0) && value.rows.some((row) => row.values[0] > 0)
  );
}

export function isCreateAdvancedArtifactInput(value: unknown): value is CreateAdvancedArtifactInput {
  if (!record(value) || !exactKeys(value, ["kind", "title", "threadId", "messageId"], ["spec", "html"])) return false;
  if (!(value.kind === "visualization" || value.kind === "internal-site") || !safeText(value.title, 120) ||
      typeof value.threadId !== "string" || !UUID_PATTERN.test(value.threadId) ||
      typeof value.messageId !== "string" || !UUID_PATTERN.test(value.messageId)) return false;
  if (value.kind === "visualization") {
    return value.html === undefined && (value.spec === undefined || isVisualizationSpec(value.spec));
  }
  return value.spec === undefined && (value.html === undefined || safeText(value.html, 250_000, true));
}

export function isCreateAdvancedArtifactVersionInput(value: unknown): value is CreateAdvancedArtifactVersionInput {
  if (!record(value) || !exactKeys(value, ["threadId", "messageId"], ["spec", "html"]) ||
      typeof value.threadId !== "string" || !UUID_PATTERN.test(value.threadId) ||
      typeof value.messageId !== "string" || !UUID_PATTERN.test(value.messageId)) return false;
  return (value.spec === undefined || isVisualizationSpec(value.spec)) &&
    (value.html === undefined || safeText(value.html, 250_000, true)) &&
    !(value.spec !== undefined && value.html !== undefined);
}

function safeApiUrl(value: unknown) {
  return typeof value === "string" && value.startsWith("/api/artifacts/") && value.length <= 500;
}

export function isAdvancedArtifactSummary(value: unknown): value is AdvancedArtifactSummary {
  if (!record(value) || !exactKeys(value, [
    "id", "kind", "title", "projectId", "threadId", "messageId", "createdAt", "updatedAt",
    "latestVersion", "publishedVersions", "previewUrl", "downloadHtmlUrl", "downloadZipUrl", "internalSiteUrl",
  ])) return false;
  return typeof value.id === "string" && UUID_PATTERN.test(value.id) &&
    (value.kind === "visualization" || value.kind === "internal-site") && safeText(value.title, 120) &&
    typeof value.projectId === "string" && UUID_PATTERN.test(value.projectId) &&
    typeof value.threadId === "string" && UUID_PATTERN.test(value.threadId) &&
    typeof value.messageId === "string" && UUID_PATTERN.test(value.messageId) &&
    typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt)) &&
    Number.isSafeInteger(value.latestVersion) && (value.latestVersion as number) >= 1 &&
    Array.isArray(value.publishedVersions) && value.publishedVersions.every((version) => Number.isSafeInteger(version) && version >= 1 && version <= (value.latestVersion as number)) &&
    safeApiUrl(value.previewUrl) && safeApiUrl(value.downloadHtmlUrl) && safeApiUrl(value.downloadZipUrl) &&
    (value.internalSiteUrl === null || safeApiUrl(value.internalSiteUrl));
}

function parseNumericCell(value: string) {
  const compact = value.trim().replace(/[€$£%\s]/g, "");
  if (!compact) return null;
  let normalized = compact;
  if (/^-?\d{1,3}(?:\.\d{3})*,\d+$/.test(compact)) normalized = compact.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(?:,\d{3})*\.\d+$/.test(compact)) normalized = compact.replace(/,/g, "");
  else if (/^-?\d+,\d+$/.test(compact)) normalized = compact.replace(",", ".");
  else normalized = compact.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 1_000_000_000 ? parsed : null;
}

function tableCells(line: string) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

/** Extracts the first honest numeric Markdown table from an existing result. */
export function visualizationSpecFromMarkdown(markdown: string, title: string): VisualizationSpec | null {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length - 2; index += 1) {
    if (!lines[index].includes("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) continue;
    const headers = tableCells(lines[index]);
    if (headers.length < 2 || headers.length > 9) continue;
    const rows: VisualizationRow[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length && lines[rowIndex].includes("|"); rowIndex += 1) {
      const cells = tableCells(lines[rowIndex]);
      if (cells.length !== headers.length || !cells[0]) break;
      const values = cells.slice(1).map(parseNumericCell);
      if (values.some((value) => value === null)) break;
      rows.push({ label: cells[0], values: values as number[] });
      if (rows.length === 50) break;
    }
    if (!rows.length) continue;
    return {
      chartType: headers.length === 2 && rows.length <= 10 ? "bar" : "line",
      title,
      xLabel: headers[0],
      yLabel: null,
      series: headers.slice(1).map((name) => ({ name, color: null })),
      rows,
    };
  }
  return null;
}
