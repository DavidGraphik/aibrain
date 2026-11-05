import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { arnallScheduleParts, type ArnallSchedule } from "./arnall-schedule";
import { generateLocalDocument } from "./local-document-generator";
import template from "./templates/arnall-schedule.json";

const data = (): ArnallSchedule => ({ establishmentId: 3, establishmentName: "Botiga de prova", week: "2026-W38", people: [
  { id: 1, name: "Persona botiga", section: "DEPENDIENTA", codeHours:{M:7,T:6,D:10}, days: [{ code: "D", firstLine: "07:30–13:30", secondLine: "16:30–20:30" }, null, { code: "V", firstLine: "", secondLine: "" }, ...Array(4).fill(null)] },
  { id: 2, name: "Persona obrador", section: "ELABORACION", codeHours:{M:4,T:4,D:8}, days: [{ code: "M", firstLine: "08:00–12:00", secondLine: "" }, ...Array(6).fill(null)] },
] });

describe("approved Arnall schedule template", () => {
  it("preserves the exact native geometry, styles, theme and print layout", () => {
    const parts = arnallScheduleParts(data());
    const sheet = parts["xl/worksheets/sheet1.xml"];
    const source = template["xl/worksheets/sheet1.xml"];
    for (const node of ["cols", "mergeCells", "sheetFormatPr", "pageMargins", "pageSetup"]) {
      const re = new RegExp(`<${node}\\b[^>]*(?:/>|>[\\s\\S]*?</${node}>)`, "u");
      expect(sheet.match(re)?.[0]).toBe(source.match(re)?.[0]);
    }
    expect(parts["xl/styles.xml"]).toBe(template["xl/styles.xml"]);
    expect(parts["xl/theme/theme1.xml"]).toBe(template["xl/theme/theme1.xml"]);
    expect(sheet).toContain('r="B54"');
    expect(sheet).toContain("TABLA DE SIGNOS");
    expect(sheet).toContain("PETICIÓN APROBADA");
    expect(sheet).not.toContain("PETICIÓ APROVADA");
    expect(sheet).toContain("16:30–20:30");
    expect(sheet).toContain('COUNTIF(E46:E91,"=M")');
  });

  it("exports one visible shop with its three calculation dependencies and no foreign data", async () => {
    const generated = await generateLocalDocument({format:"xlsx",title:"Horari",content:"Proposta",spreadsheetLayout:"schedule",arnallSchedule:data(),rows:[["Persona","Dl","Dt","Dc","Dj","Dv","Ds","Dg","Hores"]]});
    const zip = await JSZip.loadAsync(generated.data);
    expect(Object.keys(zip.files).filter(p => /^xl\/worksheets\/sheet\d+\.xml$/u.test(p))).toHaveLength(4);
    expect((await zip.file("xl/workbook.xml")!.async("text")).match(/state="hidden"/gu)).toHaveLength(3);
    expect(Object.keys(zip.files).some(p => /vba|sharedStrings|externalLinks|connections|comments/iu.test(p))).toBe(false);
    const all = (await Promise.all(Object.values(zip.files).filter(f => !f.dir).map(f => f.async("text")))).join("\n");
    for (const number of [2, 3, 4]) {
      const xml = await zip.file(`xl/worksheets/sheet${number}.xml`)!.async("text");
      for (const cell of xml.matchAll(/<c\b[^>]*?\br="([A-Z]+)(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
        const address = cell[1] + cell[2];
        if (cell[2] === "1" || (number === 2 && address === "AB3") || (number === 4 && address === "O12")) continue;
        const contents = cell[3] ?? "";
        if (/<f\b/u.test(contents)) continue;
        expect(contents).not.toMatch(/<v\b/u);
        for (const value of contents.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)) {
          expect(["Persona botiga", "Persona obrador", "Botiga de prova"]).toContain(value[1]);
        }
      }
    }
    expect(all).toContain("PESONAL!");
    expect(all).toContain("Persona botiga");
    expect(all).toContain("Persona obrador");
  });

  it("preserves every original formula element, including shared anchors and inherited defects", () => {
    const input = data();
    const people = input.people.map(p => ({...p,days:p.days.map(d => d ? {...d,requested:true} : null)}));
    const parts = arnallScheduleParts({...input,people});
    const formulaCells = (xml:string) => Array.from(xml.matchAll(/<c\b[^>]*?\br="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/gu))
      .flatMap(m => { const f=(m[2] ?? "").match(/<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/u); return f ? [[m[1],f[0]]] : []; });
    let total=0;
    for(const name of ['sheet1','sheet2','sheet3','sheet4']) {
      const part=`xl/worksheets/${name}.xml` as keyof typeof template;
      const formulas=formulaCells(parts[part]);
      expect(formulas).toEqual(formulaCells(template[part]));
      total+=formulas.length;
    }
    expect(total).toBe(2500);
    expect(parts['xl/worksheets/sheet1.xml']).not.toContain('D SI');
    expect(parts['xl/worksheets/sheet1.xml']).toContain('>D</t>');
    expect(parts['xl/worksheets/sheet2.xml']).toContain('Persona botiga');
    expect(parts['xl/worksheets/sheet4.xml']).toContain('Persona obrador');
  });

  it("does not silently truncate people, invalid weeks, duplicate IDs or missing shop identity", () => {
    expect(() => arnallScheduleParts({...data(),week:"2025-W53"})).toThrow("Semana ISO");
    expect(() => arnallScheduleParts({...data(),establishmentId:0})).toThrow();
    expect(() => arnallScheduleParts({...data(),people:[data().people[0],data().people[0]]})).toThrow();
    expect(() => arnallScheduleParts({...data(),people:Array.from({length:25},(_,i)=>({...data().people[0],id:i+1}))})).toThrow("24 dependientes");
  });

  it("keeps unassigned days empty, makes occupied source-hidden slots visible and writes names as text", () => {
    const input = data();
    const people = Array.from({length:24},(_,i)=>({...input.people[0],id:i+1,name:i===23?'=HYPERLINK("https://example.invalid")':`Persona ${i}`}));
    const sheet=arnallScheduleParts({...input,people})["xl/worksheets/sheet1.xml"];
    expect(sheet.match(/<row\b[^>]*r="52"[^>]*>/u)?.[0]).not.toContain('hidden="1"');
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK');
    expect(sheet.match(/<c\b[^>]*r="G6"[^>]*(?:\/>|>[\s\S]*?<\/c>)/u)?.[0]).not.toContain('<t>F</t>');
    expect(sheet).not.toContain('<f>HYPERLINK');
  });
});
