import template from "./templates/arnall-schedule.json";

export type ArnallSchedule = Readonly<{
  establishmentId: number;
  establishmentName: string;
  week: string;
  people: readonly Readonly<{
    id: number;
    name: string;
    section: "DEPENDIENTA" | "ELABORACION";
    maxWeeklyHours?: number;
    codeHours: Readonly<{ M: number; T: number; D: number }>;
    days: readonly (Readonly<{ code: string; firstLine: string; secondLine: string; requested?: boolean }> | null)[];
  }>[];
}>;

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !Array.from(value).some(c => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)));

/** Copies the approved form, changing cell contents only. Never carries other shops. */
export function arnallScheduleParts(input: ArnallSchedule): Record<string, string> {
  if (!input || !Number.isSafeInteger(input.establishmentId) || input.establishmentId < 1 ||
      !text(input.establishmentName, 80) || !input.establishmentName.trim() ||
      !/^\d{4}-W\d{2}$/u.test(input.week) || !Array.isArray(input.people)) throw new Error("Horario de tienda no válido.");
  const [year, week] = input.week.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000 + (week - 1) * 604_800_000);
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  if (year < 1900 || year > 9999 || week < 1 || week > 53 || thursday.getUTCFullYear() !== year) throw new Error("Semana ISO no válida.");
  const ids = new Set<number>();
  for (const person of input.people) {
    if (!person || !Number.isSafeInteger(person.id) || person.id < 1 || ids.has(person.id) || !text(person.name, 100) || !person.name.trim() ||
        !["DEPENDIENTA", "ELABORACION"].includes(person.section) || !Array.isArray(person.days) || person.days.length !== 7 ||
        !person.codeHours || [person.codeHours.M, person.codeHours.T, person.codeHours.D].some(h => !Number.isFinite(h) || h < 0 || h > 24) ||
        person.days.some((day: ArnallSchedule["people"][number]["days"][number]) => day !== null && (!day || !/^(?:M|T|D|F|V|B)$/u.test(day.code) || !text(day.firstLine, 60) || !text(day.secondLine, 60) || (day.requested !== undefined && typeof day.requested !== "boolean")))) {
      throw new Error("Personas o turnos no válidos para la plantilla.");
    }
    ids.add(person.id);
  }
  const groups = [input.people.filter(p => p.section === "DEPENDIENTA"), input.people.filter(p => p.section === "ELABORACION")];
  if (groups[0].length > 24 || groups[1].length > 19) throw new Error("La plantilla admite 24 dependientes y 19 personas de obrador. Hay que ampliar el modelo conservando el formato antes de proponer este horario.");
  const parts: Record<string, string> = { ...template };
  let sheet = parts["xl/worksheets/sheet1.xml"];
  const setInSheet = (xml: string, address: string, value: string | number, allowEmptyCell = false) => {
    const re = new RegExp(`<c\\b([^>]*\\br="${address}"[^>]*?)(?:\\s*/>|>[\\s\\S]*?</c>)`, "u");
    if (!re.test(xml)) {
      const row = address.match(/\d+$/u)![0];
      const rowPattern = new RegExp(`(<row\\b[^>]*\\br="${row}"[^>]*>)([\\s\\S]*?)(</row>)`, "u");
      if (!allowEmptyCell || !rowPattern.test(xml)) throw new Error(`Celda ausente en la plantilla: ${address}`);
      xml = xml.replace(rowPattern, (_, opening: string, contents: string, closing: string) => {
        const list = Array.from(contents.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/gu), match => match[0]);
        list.push(`<c r="${address}"/>`);
        const column = (cell: string) => Array.from(cell.match(/\br="([A-Z]+)/u)![1]).reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0);
        return opening + list.sort((a,b) => column(a)-column(b)).join("") + closing;
      });
    }
    return xml.replace(re, (cell: string, attributes: string) => {
      if (/<f(?:\s|>)/u.test(cell)) throw new Error(`No se puede sustituir una fórmula original: ${address}`);
      const attrs = attributes.replace(/\s+t="[^"]*"/gu, "");
      return typeof value === "number" ? `<c${attrs}><v>${value}</v></c>` : `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
    });
  };
  const set = (address: string, value: string | number) => { sheet = setInSheet(sheet, address, value); };
  // Request-blue is already described by the source legend. Keep the literal
  // shift code unchanged: suffixing SI would break its exact-match formulas.
  const requestedStyles = new Map<string, number>();
  const markRequested = (address: string) => {
    const cell = new RegExp(`<c\\b([^>]*\\br="${address}"[^>]*)>`, "u");
    sheet = sheet.replace(cell, (_, attributes: string) => {
      const original = attributes.match(/\bs="(\d+)"/u)?.[1];
      if (!original) throw new Error("Falta el estilo del turno.");
      if (!requestedStyles.has(original)) {
        let styles = parts["xl/styles.xml"];
        const xfBlock = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u)![1];
        const xfs = Array.from(xfBlock.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/gu), m => m[0]);
        const base = xfs[Number(original)];
        const fontId = Number(base.match(/\bfontId="(\d+)"/u)![1]);
        const fontBlock = styles.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/u)![1];
        const fonts = Array.from(fontBlock.matchAll(/<font>[\s\S]*?<\/font>/gu), m => m[0]);
        const blue = fonts[fontId].replace(/<color\b[^>]*\/>/u, '').replace('</font>', '<color rgb="FF305496"/></font>');
        const variant = base.replace(/\bfontId="\d+"/u, `fontId="${fonts.length}"`);
        styles = styles.replace(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/u, `<fonts count="${fonts.length + 1}">${fontBlock}${blue}</fonts>`)
          .replace(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/u, `<cellXfs count="${xfs.length + 1}">${xfBlock}${variant}</cellXfs>`);
        parts["xl/styles.xml"] = styles;
        requestedStyles.set(original, xfs.length);
      }
      return `<c${attributes.replace(/\bs="\d+"/u, `s="${requestedStyles.get(original)}"`)}>`;
    });
  };
  // Spanish presentation only: preserve shift codes, sheet names and all formulas.
  const labels: Record<string, string> = {
    "B1": "LAS VACACIONES EMPEZARÁN EL LUNES",
    "AA1": "ÚLTIMA ACTUALIZACIÓN",
    "B2": "NO OS ANOTÉIS TODOS LOS DÍAS,                  ¡GRACIAS!",
    "AB2": "Días que adelantan el horario a cumplir",
    "AC2": "DÍAS SEMANA ACTUAL",
    "AD2": "VACACIONES POR HACER",
    "AE2": "VACACIONES HECHAS",
    "AF2": "COMPENSADAS",
    "AG2": "VACACIONES PENDIENTES AÑO ACTUAL",
    "AH2": "VACACIONES PENDIENTES AÑO ANTERIOR",
    "AI2": "VACACIONES PENDIENTES TOTALES",
    "AJ2": "CUADRANTE PARA SUMAR HORAS POR CÓDIGO",
    "AU2": "FECHA",
    "AU3": "días a sumar",
    "B4": "SEM. N.º",
    "V4": "TABLA DE SIGNOS",
    "E5": "LUN",
    "F5": "Horas",
    "G5": "MAR",
    "H5": "Horas",
    "I5": "MIÉ",
    "J5": "Horas",
    "K5": "JUE",
    "L5": "Horas",
    "M5": "VIE",
    "N5": "Horas",
    "O5": "SÁB",
    "P5": "Horas",
    "Q5": "DOM",
    "R5": "Horas",
    "V5": "EJEMPLOS",
    "Z5": "PROGRAMADO",
    "AA5": "PENDIENTE",
    "AB5": "DIFERENCIA",
    "AV5": "TIENDA",
    "X6": "MAÑANA",
    "X7": "EN EL MISMO LOCAL",
    "X8": "MAÑANA EN",
    "X9": "EL OTRO LOCAL",
    "X10": "TARDE EN NUESTRO",
    "X11": "LOCAL",
    "X12": "TARDE EN NUESTRO",
    "X13": "LOCAL",
    "X14": "TARDE EN OTRO LOCAL",
    "X16": "LIBRE",
    "X18": "VACACIONES",
    "X20": "COLOR AZUL",
    "X21": "PETICIÓN APROBADA",
    "X22": "DÍA EN EL MISMO LOCAL",
    "X24": "EN EL MISMO LOCAL",
    "X26": "DÍA REPARTIDO EN DOS",
    "X27": "LOCALES",
    "W28": "CURSO",
    "W36": "CURSO",
    "W58": "CURSO",
    "X28": "ACTIVIDAD FUERA DEL LOCAL CON HORA DE INICIO Y FIN",
    "X36": "ACTIVIDAD FUERA DEL LOCAL CON HORA DE INICIO Y FIN",
    "X58": "ACTIVIDAD FUERA DEL LOCAL CON HORA DE INICIO Y FIN",
    "B93": "DEPENDIENTES",
    "B95": "SUMA DEPENDIENTES",
    "B97": "SOLO DEBÉIS ANOTAR LOS FESTIVOS QUE NECESITÉIS",
    "AH97": "SEM. N.º",
    "AK98": "LUNES",
    "AM98": "MARTES",
    "AO98": "MIÉRCOLES",
    "AQ98": "JUEVES",
    "AS98": "VIERNES",
    "AU98": "SÁBADO",
    "AW98": "DOMINGO",
    "B99": "M y T completo",
    "AJ99": "MAÑANA",
    "AJ100": "TARDE",
    "BA100": "SUMA HORAS SEMANA",
    "BF100": "Precio Hora",
    "BG100": "Cálculo Teórico",
    "BH100": "Coste Real",
    "BI100": "Estructura",
    "BJ100": "Margen - FT’S",
    "BA101": "CAJA DE LA SEMANA",
    "BA102": "PRODUCTIVIDAD SEMANAL"
};
  for (const [address, label] of Object.entries(labels)) set(address, label);
  const auxiliaryLabels: Record<number, Record<string, string>> = {
    2: { A1: "NOMBRE CORTO", B1: "NOMBRE Y APELLIDOS", C1: "TELÉFONO", D1: "Acuerdos", E1: "TIENDA", V1: "POR REVISAR", Y1: "NIVEL", AB3: "FECHA" },
    3: { A1: "Nombre del Padre", B1: "Trabajadores", D1: "EXCESO VACACIONES 2022 (NO UTILIZAMOS)", E1: "OTROS", F1: "OTROS2", G1: "OTROS3", H1: "OTROS4", I1: "TOTAL VACACIONES USADAS", K1: "VACACIONES POR HACER", L1: "VACACIONES REALIZADAS", N1: "VACACIONES AÑO ANTERIOR", R1: "VACACIONES 2023 PENDIENTES PARA 2024", S1: "COMENTARIOS", T1: "OTROS5" },
    4: { A1: "NOMBRE CORTO", B1: "NOMBRE LARGO", D1: "NÚM. EMPRESA", F1: "CALENDARIO", G1: "HORAS", I1: "A CUMPLIR", K1: "TIENDA", O12: "Fecha última actualización" },
  };
  for (const [number, translations] of Object.entries(auxiliaryLabels)) {
    const part = `xl/worksheets/sheet${number}.xml`;
    for (const [address, label] of Object.entries(translations)) parts[part] = setInSheet(parts[part], address, label);
    // A table's column names must agree with its header cells. Translating only
    // the worksheet leaves inconsistent table metadata for Excel to repair.
    const tablePart = `xl/tables/table${Number(number) - 1}.xml`;
    const columns = Array.from(parts[tablePart].matchAll(/<tableColumn\b[^>]*>/gu));
    for (const [address, label] of Object.entries(translations)) {
      if (!address.endsWith("1")) continue;
      const column = Array.from(address.replace(/\d+$/u, "")).reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0);
      const original = columns[column - 1]?.[0];
      if (original) parts[tablePart] = parts[tablePart].replace(original, original.replace(/\bname="[^"]*"/u, `name="${escape(label)}"`));
    }
  }

  set("G4", input.establishmentName); set("D4", week); set("O4", year);
  const cols = ["E", "G", "I", "K", "M", "O", "Q"];
  let auxiliaryRow = 2;
  groups.forEach((people, group) => people.forEach((person, index) => {
    const row = (group === 0 ? 6 : 54) + index * 2;
    set(`B${row}`, person.name);
    // Hour-code mappings are inputs to the original formulas, not replacements
    // for them. Reduced shifts use the actual employee duration.
    set(`AJ${row}`, person.codeHours.M); set(`AO${row}`, person.codeHours.T); set(`AQ${row}`, person.codeHours.D);
    // Only this person's lookup keys enter the three auxiliary tables. Historic
    // balances/monthly agreements remain blank until their real source exists.
    for (const [number, shopColumn] of [[2, "E"], [3, "C"], [4, "K"]] as const) {
      const part = `xl/worksheets/sheet${number}.xml`;
      for (const column of ["A", "B"]) parts[part] = setInSheet(parts[part], `${column}${auxiliaryRow}`, person.name, true);
      parts[part] = setInSheet(parts[part], `${shopColumn}${auxiliaryRow}`, input.establishmentName, true);
    }
    auxiliaryRow++;
    // A source-hidden empty slot must not hide an assigned employee.
    for (const r of [row, row + 1]) sheet = sheet.replace(new RegExp(`<row\\b([^>]*\\br="${r}"[^>]*)>`, "u"), (_, attrs: string) => `<row${attrs.replace(/\s+hidden="1"/u, "")}>`);
    person.days.forEach((day: ArnallSchedule["people"][number]["days"][number], dayIndex: number) => {
      if (!day) return; // Empty means unassigned; it never means a day off.
      const col = cols[dayIndex]; const hours = String.fromCharCode(col.charCodeAt(0) + 1);
      set(`${col}${row}`, day.code);
      set(`${hours}${row}`, day.firstLine);
      set(`${hours}${row + 1}`, day.secondLine);
      if (day.requested) markRequested(`${col}${row}`);
    });
  }));
  // All 2,499 original schedule formulas, including known defects and original
  // overlapping total ranges, remain exactly as supplied by the user.
  parts["xl/worksheets/sheet1.xml"] = sheet;
  return parts;
}
