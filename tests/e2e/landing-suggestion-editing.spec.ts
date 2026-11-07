import { expect, test } from "@playwright/test";
import { establishDemoSession } from "../helpers/playwright-auth";

test.setTimeout(60_000);

const suggestions = [
  { button: "Resumir documentos", prompt: "Ayúdame a resumir estos documentos para Example Laboratory: … Usa solo el material aportado o autorizado, cita las fuentes y destaca decisiones, dudas y datos que faltan." },
  { button: "Comparar opciones", prompt: "Comparemos estas opciones para Example Laboratory: … Organiza criterios, ventajas, costes conocidos y dudas con los datos disponibles. Indica qué falta para decidir sin inventar cifras ni compromisos." },
  { button: "Organizar los próximos pasos", prompt: "Ayúdame a organizar los próximos pasos de este trabajo de Example Laboratory: … A partir de la información aportada, resume pendientes, dependencias y preguntas. Propón responsables y fechas para revisar, sin crear tareas programadas ni enviar mensajes." },
];

for (const width of [390, 1440]) for (const suggestion of suggestions) {
  test(`suggestion ${suggestion.prompt} preserves native editing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await establishDemoSession(page, "example-user");
    const input = page.getByRole("textbox", { name: "Mensaje", exact: true });
    await page.getByRole("button", { name: suggestion.button, exact: true }).click();
    await expect(input).toHaveValue(suggestion.prompt);
    await expect(input).toBeFocused();
    await expect.poll(() => input.evaluate(el => (el as HTMLTextAreaElement).selectionStart)).toBe(suggestion.prompt.length);

    // A real pointer click must survive the focus/select React renders.
    await input.click({ position: { x: 80, y: 22 } });
    const caret = await input.evaluate(el => (el as HTMLTextAreaElement).selectionStart);
    expect(caret).toBeGreaterThan(0);
    expect(caret).toBeLessThan(suggestion.prompt.length);
    await input.pressSequentially(" aquí ");
    const edited = `${suggestion.prompt.slice(0, caret)} aquí ${suggestion.prompt.slice(caret)}`;
    await expect(input).toHaveValue(edited);

    // Losing focus and returning must not reset the next insertion to the start.
    await page.getByRole("heading", { level: 1 }).click();
    await input.click({ position: { x: 80, y: 22 } });
    const nextCaret = await input.evaluate(el => (el as HTMLTextAreaElement).selectionStart);
    expect(nextCaret).toBeGreaterThan(0);
    await input.pressSequentially("text ");
    await expect(input).toHaveValue(`${edited.slice(0, nextCaret)}text ${edited.slice(nextCaret)}`);
  });
}
