import type { ArnallSchedule } from "./arnall-schedule";

const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"] as const;

function intervalHours(value: string): number | null {
  const match = /^(\d{2}):(\d{2})\s*[–-]\s*(\d{2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const [startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number);
  if (startHour > 23 || endHour > 24 || startMinute > 59 || endMinute > 59 || (endHour === 24 && endMinute !== 0)) return null;
  const minutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
  return minutes > 0 ? minutes / 60 : null;
}

/** Checks the actual grid before the bundled template is attached. */
export function reviewFictionalArnallSchedule(schedule: ArnallSchedule) {
  const coverage = DAYS.map((day) => ({ day, morning: 0, afternoon: 0 }));
  const people = schedule.people.map((person) => {
    if (!Array.isArray(person.days) || person.days.length !== 7 || person.days.some((day) => day === null)) {
      throw new Error(`Hay días sin marcar para ${person.name || "una persona"}. Use F para los días libres.`);
    }
    const shifts = { M: 0, T: 0, D: 0 };
    let hours = 0;
    let workDays = 0;
    person.days.forEach((day, index) => {
      if (!day) return;
      if (day.code === "M" || day.code === "T" || day.code === "D") {
        const first = intervalHours(day.firstLine);
        const second = day.code === "D" ? intervalHours(day.secondLine) : (day.secondLine.trim() ? null : 0);
        const expected = person.codeHours[day.code as "M" | "T" | "D"];
        if (first === null || second === null || !Number.isFinite(expected) || Math.abs(first + second - expected) > 1 / 60) {
          throw new Error(`El turno de ${person.name} del ${DAYS[index]} no coincide con sus horas de código.`);
        }
        if (day.code === "D" && day.firstLine.trim().slice(-5) > day.secondLine.trim().slice(0, 5)) throw new Error(`Los intervalos de ${person.name} se solapan.`);
        shifts[day.code as "M" | "T" | "D"]++;
        workDays++;
        hours += first + second;
        if (day.code !== "T") coverage[index].morning++;
        if (day.code !== "M") coverage[index].afternoon++;
      } else if (["F", "V", "B"].includes(day.code)) {
        if (day.firstLine.trim() || day.secondLine.trim()) throw new Error(`El día libre o ausencia de ${person.name} contiene un horario.`);
      } else {
        throw new Error(`Código de turno no válido para ${person.name}.`);
      }
    });
    const maximum = person.maxWeeklyHours ?? 40;
    if (!Number.isFinite(maximum) || maximum < 0 || maximum > 40 || hours > maximum + 1e-8) {
      throw new Error(`El horario de ${person.name} suma ${hours} horas y supera el máximo de ${maximum}.`);
    }
    return { name: person.name, workDays, shifts, hours };
  });
  return { people, coverage, totalHours: people.reduce((sum, person) => sum + person.hours, 0) };
}
