import "server-only";

/** Browser navigation must never render native errors, callback parameters or
 * provider messages. All content and the return target are fixed application
 * text; API callers retain typed JSON errors in their POST endpoints. */
function page(title: string, message: string, status: number) {
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p role="status">${message}</p><p><a href="/?settings=connectors">Volver a Conexiones</a></p></main></body></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

export function nativeOAuthBrowserFailure(code: string, status: number) {
  let message = "La conexión no está disponible. Revisa la configuración del servicio con tu administrador.";
  if (code === "AUTH_REQUIRED") message = "Inicia sesión con tu cuenta y vuelve a abrir Conexiones para continuar.";
  else if (code === "ORIGIN_DENIED") message = "Abre Conexiones desde tu aplicación para iniciar la autorización.";
  else if (/SCOPE_DENIED|IDENTITY_|ACCESS_DENIED|RESOURCE_INVALID/.test(code)) message = "Esta conexión no está disponible para tu cuenta. Revisa tus permisos con tu administrador.";
  else if (/ATTEMPT_EXPIRED|ATTEMPT_REPLAYED|ATTEMPT_REVOKED|ATTEMPT_UNKNOWN|STATE_UNKNOWN|RUNTIME_CHANGED/.test(code)) message = "Este enlace de autorización ya no es válido. Vuelve a Conexiones para comprobar el estado e iniciar una nueva conexión si hace falta.";
  else if (code === "NATIVE_OAUTH_STATIC_CALLBACK_UNSUPPORTED" || code === "NATIVE_OAUTH_CALLBACK_VARIANT_UNSUPPORTED" || code === "NATIVE_OAUTH_CALLBACK_STATE_UNSUPPORTED") message = "Este proveedor no permite completar la conexión con la configuración actual. Tu administrador debe revisar la compatibilidad de la conexión.";
  return page("No se ha podido conectar", message, status);
}

export function nativeOAuthBrowserResult(result: "verified" | "pending" | "failed") {
  if (result === "verified") return new Response(null, { status: 303, headers: {
    Location: "/?settings=connectors", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
  } });
  if (result === "pending") return page("Conexión pendiente de verificación", "La autorización todavía no se ha podido verificar. Revisa su estado en Conexiones antes de volver a intentarlo.", 200);
  return page("No se ha podido conectar", "No se ha podido completar la autorización. Revisa su estado en Conexiones antes de volver a intentarlo.", 200);
}
