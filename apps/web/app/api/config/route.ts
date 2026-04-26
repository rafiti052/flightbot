import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Proxies config saves to the bot Express API so validation stays in one place.
 * Set FLIGHTBOT_BOT_URL (e.g. http://localhost:3000 or http://flightbot:3000 in Compose).
 */
export async function PUT(req: Request) {
  const base = process.env.FLIGHTBOT_BOT_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json(
      { error: "Set FLIGHTBOT_BOT_URL to the bot admin base URL (e.g. http://localhost:3000)." },
      { status: 501 },
    );
  }
  const body = await req.text();
  const upstream = await fetch(`${base}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
  });
}
