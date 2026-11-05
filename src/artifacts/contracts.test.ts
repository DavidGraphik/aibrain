import { describe, expect, it } from "vitest";
import { isVisualizationSpec, visualizationSpecFromMarkdown } from "@/artifacts/contracts";

describe("advanced artifact contracts", () => {
  it("extracts a limited visualization only from a real numeric Markdown table", () => {
    const spec = visualizationSpecFromMarkdown(`
| Región | Ingresos | Margen |
| --- | ---: | ---: |
| Norte | 120.000,50 € | 24,5 % |
| Sur | 98.400,00 € | 19,2 % |
`, "Rendimiento regional");
    expect(spec).toMatchObject({
      chartType: "line",
      title: "Rendimiento regional",
      series: [{ name: "Ingresos", color: null }, { name: "Margen", color: null }],
    });
    expect(spec?.rows[0]).toEqual({ label: "Norte", values: [120000.5, 24.5] });
    expect(isVisualizationSpec(spec)).toBe(true);
  });

  it("refuses prose and executable or unbounded chart grammars", () => {
    expect(visualizationSpecFromMarkdown("Las ventas parecen mejorar.", "Ventas")).toBeNull();
    expect(isVisualizationSpec({
      chartType: "javascript",
      title: "<script>alert(1)</script>",
      xLabel: null,
      yLabel: null,
      series: [{ name: "Serie", color: null }],
      rows: [{ label: "A", values: [1] }],
      script: "alert(1)",
    })).toBe(false);
  });
});
