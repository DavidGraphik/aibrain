import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { personalUsageForUser } from "@/usage/server-service";
import { employeeWeeklyBudget, EmployeeBudgetAccessError } from "@/usage/employee-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "No autenticat.", code: "AUTH_REQUIRED" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }
  try {
    const budget = await employeeWeeklyBudget(session);
    if (budget) return NextResponse.json({ budget: null }, { headers: NO_STORE_HEADERS });
    return NextResponse.json(
      await personalUsageForUser(session.user.id),
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof EmployeeBudgetAccessError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(
      { error: "No s’ha pogut consultar l’ús.", code: "USAGE_UNAVAILABLE" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
