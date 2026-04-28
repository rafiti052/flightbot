import { NextResponse } from "next/server";
import { getSessionOr401Response } from "@/lib/requireSession";
import { validateOriginHost } from "@/lib/csrf";

export const dynamic = "force-dynamic";

/**
 * Proxies config saves to the bot Express API so validation stays in one place.
 * Set FLIGHTBOT_BOT_URL (e.g. http://localhost:3000 or http://flightbot:3000 in Compose).
 */
export async function PUT(req: Request) {
  const auth = await getSessionOr401Response();
  if (!auth.ok) return auth.response;

  const csrf = validateOriginHost(req);
  if (!csrf.ok) {
    return NextResponse.json(
      { error: "Forbidden", reason: csrf.reason },
      { status: 403 },
    );
  }

  const base = process.env.FLIGHTBOT_BOT_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json(
      { error: "Set FLIGHTBOT_BOT_URL to the bot admin base URL (e.g. http://localhost:3000)." },
      { status: 501 },
    );
  }
  const token = process.env.FLIGHTBOT_ADMIN_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Set FLIGHTBOT_ADMIN_TOKEN to the shared bearer token for the bot admin API." },
      { status: 501 },
    );
  }
  const body = await req.text();
  const upstream = await fetch(`${base}/config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
  });
}
