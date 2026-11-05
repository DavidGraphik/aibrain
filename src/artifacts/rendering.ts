import sanitizeHtml from "sanitize-html";
import type { AdvancedArtifactSnapshot, VisualizationSpec } from "@/artifacts/contracts";

const palette = ["#166534", "#2563eb", "#9333ea", "#c2410c", "#0f766e", "#be123c", "#4f46e5", "#6b7280"];

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] ?? character);
}

export function sanitizeInternalSiteHtml(value: string) {
  return sanitizeHtml(value, {
    allowedTags: [
      "article", "section", "header", "footer", "main", "nav", "h1", "h2", "h3", "h4",
      "p", "br", "hr", "strong", "em", "s", "blockquote", "code", "pre", "ul", "ol", "li",
      "table", "thead", "tbody", "tr", "th", "td", "caption", "a", "span", "div",
    ],
    allowedAttributes: { a: ["href", "title", "rel"], th: ["scope"], td: ["colspan", "rowspan"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, rel: "noreferrer noopener" },
      }),
    },
  });
}

export function internalSiteFromMessage(markdown: string) {
  const blocks = markdown.trim().split(/\n\s*\n/).filter(Boolean).map((block) => {
    const text = block.trim();
    const heading = text.match(/^(#{1,4})\s+(.+)$/s);
    if (heading) {
      const level = Math.min(4, heading[1].length + 1);
      return `<h${level}>${escapeHtml(heading[2].trim())}</h${level}>`;
    }
    const list = text.split(/\r?\n/);
    if (list.every((line) => /^[-*]\s+/.test(line))) {
      return `<ul>${list.map((line) => `<li>${escapeHtml(line.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    return `<p>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</p>`;
  }).join("\n");
  return sanitizeInternalSiteHtml(`<article>${blocks}</article>`);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(value);
}

export function renderVisualizationSvg(spec: VisualizationSpec) {
  const width = 960;
  const height = 520;
  if (spec.chartType === "pie") {
    const total = spec.rows.reduce((sum, row) => sum + row.values[0], 0);
    let angle = -Math.PI / 2;
    const paths = spec.rows.map((row, index) => {
      const portion = row.values[0] / total;
      const nextAngle = angle + portion * Math.PI * 2;
      const largeArc = portion > 0.5 ? 1 : 0;
      const startX = 310 + Math.cos(angle) * 155;
      const startY = 255 + Math.sin(angle) * 155;
      const endX = 310 + Math.cos(nextAngle) * 155;
      const endY = 255 + Math.sin(nextAngle) * 155;
      const path = portion >= 0.999999
        ? `<circle cx="310" cy="255" r="155" fill="${palette[index % palette.length]}"/>`
        : `<path d="M 310 255 L ${startX} ${startY} A 155 155 0 ${largeArc} 1 ${endX} ${endY} Z" fill="${palette[index % palette.length]}"/>`;
      angle = nextAngle;
      return `<g>${path}<title>${escapeHtml(`${row.label}: ${formatNumber(row.values[0])} (${formatNumber(portion * 100)} %)` )}</title></g>`;
    }).join("");
    const legend = spec.rows.map((row, index) => `<g transform="translate(540,${105 + index * 32})"><rect width="14" height="14" rx="4" fill="${palette[index % palette.length]}"/><text x="22" y="12" fill="#374151" font-size="13">${escapeHtml(row.label.slice(0, 28))} · ${escapeHtml(formatNumber(row.values[0]))}</text></g>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-desc"><title id="chart-title">${escapeHtml(spec.title)}</title><desc id="chart-desc">Gráfico circular con ${spec.rows.length} categorías.</desc><rect width="100%" height="100%" fill="#ffffff"/><text x="70" y="38" fill="#111827" font-size="20" font-weight="700">${escapeHtml(spec.title)}</text>${paths}${legend}</svg>`;
  }
  const left = 78;
  const top = 48;
  const chartWidth = 820;
  const chartHeight = 360;
  const values = spec.rows.flatMap((row) => row.values);
  const lower = Math.min(0, ...values);
  const upper = Math.max(0, ...values);
  const range = upper - lower || 1;
  const y = (value: number) => top + chartHeight - ((value - lower) / range) * chartHeight;
  const zeroY = y(0);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = lower + (range * index) / 4;
    const lineY = y(value);
    return `<line x1="${left}" y1="${lineY}" x2="${left + chartWidth}" y2="${lineY}" stroke="#e5e7eb"/><text x="${left - 10}" y="${lineY + 4}" text-anchor="end" fill="#6b7280" font-size="12">${escapeHtml(formatNumber(value))}</text>`;
  }).join("");
  let marks = "";
  if (spec.chartType === "bar") {
    const groupWidth = chartWidth / spec.rows.length;
    const barWidth = Math.max(4, Math.min(44, (groupWidth - 10) / spec.series.length));
    marks = spec.rows.map((row, rowIndex) => row.values.map((value, seriesIndex) => {
      const x = left + rowIndex * groupWidth + (groupWidth - barWidth * spec.series.length) / 2 + seriesIndex * barWidth;
      const valueY = y(value);
      const barY = value >= 0 ? valueY : zeroY;
      const barHeight = Math.max(1, Math.abs(zeroY - valueY));
      const color = spec.series[seriesIndex].color ?? palette[seriesIndex];
      return `<rect x="${x}" y="${barY}" width="${Math.max(2, barWidth - 2)}" height="${barHeight}" rx="3" fill="${color}"><title>${escapeHtml(`${row.label} · ${spec.series[seriesIndex].name}: ${formatNumber(value)}`)}</title></rect>`;
    }).join("")).join("");
  } else {
    marks = spec.series.map((series, seriesIndex) => {
      const points = spec.rows.map((row, rowIndex) => `${left + ((rowIndex + 0.5) / spec.rows.length) * chartWidth},${y(row.values[seriesIndex])}`).join(" ");
      const color = series.color ?? palette[seriesIndex];
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>${spec.rows.map((row, rowIndex) => `<circle cx="${left + ((rowIndex + 0.5) / spec.rows.length) * chartWidth}" cy="${y(row.values[seriesIndex])}" r="5" fill="${color}"><title>${escapeHtml(`${row.label} · ${series.name}: ${formatNumber(row.values[seriesIndex])}`)}</title></circle>`).join("")}`;
    }).join("");
  }
  const labels = spec.rows.map((row, index) => {
    const x = left + ((index + 0.5) / spec.rows.length) * chartWidth;
    const label = row.label.length > 14 ? `${row.label.slice(0, 13)}…` : row.label;
    return `<text x="${x}" y="${top + chartHeight + 28}" text-anchor="middle" fill="#4b5563" font-size="12"><title>${escapeHtml(row.label)}</title>${escapeHtml(label)}</text>`;
  }).join("");
  const legend = spec.series.map((series, index) => `<g transform="translate(${left + index * 150},470)"><rect width="12" height="12" rx="3" fill="${series.color ?? palette[index]}"/><text x="19" y="11" fill="#374151" font-size="12">${escapeHtml(series.name.slice(0, 18))}</text></g>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-desc"><title id="chart-title">${escapeHtml(spec.title)}</title><desc id="chart-desc">Visualización ${escapeHtml(spec.chartType)} con ${spec.rows.length} categorías y ${spec.series.length} series.</desc><rect width="100%" height="100%" fill="#ffffff"/><text x="${left}" y="28" fill="#111827" font-size="20" font-weight="700">${escapeHtml(spec.title)}</text>${grid}<line x1="${left}" y1="${zeroY}" x2="${left + chartWidth}" y2="${zeroY}" stroke="#9ca3af"/>${marks}${labels}${legend}</svg>`;
}

function shell(title: string, body: string, kind: "visualization" | "internal-site") {
  const mode = kind === "internal-site" ? "Sitio interno" : "Visualización";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f6f6f3;color:#242421;font:16px/1.65 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{padding:18px 24px;border-bottom:1px solid #e5e5df;background:#fff;display:flex;justify-content:space-between;gap:16px;align-items:center}header strong{font-size:15px}header span{font-size:12px;color:#6b6b64}.page{width:min(1040px,calc(100% - 32px));margin:28px auto;background:#fff;border:1px solid #e5e5df;border-radius:22px;padding:clamp(22px,5vw,60px);box-shadow:0 16px 60px rgba(34,34,30,.07)}h1,h2,h3,h4{line-height:1.2}h1{font-size:clamp(30px,5vw,52px)}h2{margin-top:2em}a{color:#14532d}table{width:100%;border-collapse:collapse;display:block;overflow:auto}th,td{padding:10px;border-bottom:1px solid #e5e5df;text-align:left}blockquote{border-left:3px solid #86a88e;margin-left:0;padding-left:18px;color:#585852}pre{overflow:auto;background:#f1f1ed;padding:16px;border-radius:12px}svg{display:block;width:100%;height:auto}@media(max-width:600px){header{padding:14px 16px}.page{width:100%;margin:0;border:0;border-radius:0;padding:22px;box-shadow:none}}</style></head><body><header><strong>${escapeHtml(title)}</strong><span>${mode} · acceso de empresa</span></header><main class="page">${body}</main></body></html>`;
}

export function renderArtifactHtml(snapshot: AdvancedArtifactSnapshot) {
  if (snapshot.content.kind === "visualization") {
    return shell(snapshot.title, renderVisualizationSvg(snapshot.content.spec), "visualization");
  }
  return shell(snapshot.title, sanitizeInternalSiteHtml(snapshot.content.html), "internal-site");
}

export const ARTIFACT_PREVIEW_CSP = [
  "default-src 'none'", "base-uri 'none'", "connect-src 'none'", "font-src 'none'",
  "form-action 'none'", "frame-ancestors 'self'", "img-src data:", "media-src 'none'",
  "object-src 'none'", "script-src 'none'", "style-src 'unsafe-inline'",
].join("; ");
