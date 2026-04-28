export type CsrfValidationResult = { ok: true } | { ok: false; reason: string };

function getRequestHost(req: Request): string | null {
  const forwardedHost = req.headers.get("x-forwarded-host")?.trim();
  if (forwardedHost) return forwardedHost.toLowerCase();

  const host = req.headers.get("host")?.trim();
  if (host) return host.toLowerCase();

  try {
    return new URL(req.url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function validateOriginHost(req: Request): CsrfValidationResult {
  const origin = req.headers.get("origin")?.trim();
  if (!origin) return { ok: false, reason: "missing origin" };

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return { ok: false, reason: "invalid origin" };
  }

  const requestHost = getRequestHost(req);
  if (!requestHost) return { ok: false, reason: "missing host" };

  if (originHost !== requestHost) return { ok: false, reason: "origin host mismatch" };

  return { ok: true };
}
