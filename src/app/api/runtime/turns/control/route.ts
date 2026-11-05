import { stopOrphanedUnsubmittedTurn } from "@/runtime/orphaned-turn-stop";
import { NextResponse } from "next/server";
import { operationalLogger } from "@/operations/server-logger";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { loadInstallationConfig } from "@/config/installation";
import { isTurnControlRequest } from "@/lib/chat-contract";
import { readThreadToken } from "@/runtime/thread-token";
import { cancelPendingWorkerTurn, controlWorkerTurn, TurnControlError } from "@/runtime/turn-control";
import { workbenchErrorResponse } from "@/workbench/http";
import { finishThreadTurn, getThreadRuntimeContext } from "@/workbench/store";
import { FileTurnProjectionStore } from "@/workbench/turn-projection-store";

export const runtime = "nodejs";

function activityId(action: "stop" | "steer", clientRequestId: string) {
  return `${action}:${clientRequestId}`;
}

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  if (!isTurnControlRequest(body)) {
    return NextResponse.json({ error: "El control del torn no és vàlid." }, { status: 400 });
  }

  try {
    const installation = await loadInstallationConfig();
    if (installation.installationId !== session.tenant.id || session.provider !== "local") {
      return NextResponse.json({ error: "La sessió no pertany a aquest runtime." }, { status: 403 });
    }
    const context = await getThreadRuntimeContext(session, body.threadId);
    const projections = new FileTurnProjectionStore({
      installationId: installation.installationId,
      userId: session.user.id,
      usersRoot: installation.paths.usersRoot,
    });
    const projection = await projections.read(body.threadId, body.assistantMessageId);
    if (!projection) {
      // Context authorization above remains mandatory. This is still a failure,
      // with no persisted control or cancellation acknowledgement. A client that
      // has not observed chat admission can retain its bound intent until then.
      return NextResponse.json(
        { error: "El torn no existeix.", code: "TURN_PROJECTION_NOT_FOUND" },
        { status: 404 },
      );
    }

    const accepted = projection.message.activity.some((item) =>
      item.id === activityId(body.action, body.clientRequestId));
    if (body.action === "stop" && projection.message.status === "streaming" && !projection.runtimeTurnId) {
      const stopped = await stopOrphanedUnsubmittedTurn({
        installationId: installation.installationId,
        usersRoot: installation.paths.usersRoot,
        userId: session.user.id,
        threadId: body.threadId,
        assistantMessageId: body.assistantMessageId,
        projectId: context.projectId,
      }, async () => {
        await projections.applyLocalEvent(body.threadId, body.assistantMessageId, {
          type: "activity",
          item: {
            id: activityId("stop", body.clientRequestId),
            kind: "system",
            label: "Aturada confirmada abans d’enviar la petició",
            status: "stopped",
          },
        });
        const terminal = await projections.applyLocalEvent(body.threadId, body.assistantMessageId, { type: "stopped" });
        await finishThreadTurn(session, body.threadId, terminal.message, terminal.runtimeThreadToken);
      });
      if (stopped) return NextResponse.json({ ok: true, action: body.action, idempotent: accepted });
    }
    if (accepted) {
      return NextResponse.json({ ok: true, action: body.action, idempotent: true });
    }
    if (projection.message.status !== "streaming") {
      return NextResponse.json(
        { error: "Aquest torn ja no accepta controls." },
        { status: 409 },
      );
    }
    const persistAccepted = async (event: Parameters<typeof projections.applyLocalEvent>[2]) => {
      await projections.applyLocalEvent(body.threadId, body.assistantMessageId, event);
    };
    if (!projection.runtimeThreadToken) {
      if (body.action !== "stop") {
        return NextResponse.json(
          { error: "El torn encara no té una identitat de runtime controlable." },
          { status: 409 },
        );
      }
      await cancelPendingWorkerTurn({
        installationId: installation.installationId,
        userId: session.user.id,
        runtimeThreadId: null,
      }, body, persistAccepted);
      return NextResponse.json({ ok: true, action: body.action, idempotent: false });
    }
    const runtimeThreadId = readThreadToken(
      projection.runtimeThreadToken,
      installation.installationId,
      session.user.id,
    );
    if (!runtimeThreadId) {
      return NextResponse.json({ error: "La identitat privada del torn no és vàlida." }, { status: 409 });
    }
    if (context.runtimeThreadToken) {
      const contextThreadId = readThreadToken(
        context.runtimeThreadToken,
        installation.installationId,
        session.user.id,
      );
      if (contextThreadId !== runtimeThreadId) {
        return NextResponse.json({ error: "La continuïtat del fil ha canviat." }, { status: 409 });
      }
    }

    if (!projection.runtimeTurnId) {
      if (body.action !== "stop") {
        return NextResponse.json(
          { error: "El torn encara no té una identitat de runtime controlable." },
          { status: 409 },
        );
      }
      await cancelPendingWorkerTurn({
        installationId: installation.installationId,
        userId: session.user.id,
        runtimeThreadId,
      }, body, persistAccepted);
      return NextResponse.json({ ok: true, action: body.action, idempotent: false });
    }

    await controlWorkerTurn({
      installationId: installation.installationId,
      userId: session.user.id,
      runtimeThreadId,
      runtimeTurnId: projection.runtimeTurnId,
    }, body, persistAccepted);
    return NextResponse.json({ ok: true, action: body.action, idempotent: false });
  } catch (error) {
    if (error instanceof TurnControlError) {
      operationalLogger.warn("turn.control_rejected", { code: error.code });
      return NextResponse.json(
        { error: "Codex no ha pogut aplicar aquest control al torn actiu." },
        { status: error.code === "TURN_CONTROL_RESPONSE_INVALID" ? 502 : 409 },
      );
    }
    return workbenchErrorResponse(error, "No s’ha pogut controlar el torn de forma segura.");
  }
}
