import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function botBaseUrl() {
  const base = process.env.FLIGHTBOT_BOT_URL?.replace(/\/$/, "");
  if (!base) throw new Error("FLIGHTBOT_BOT_URL is not set");
  return base;
}

function botToken() {
  const token = process.env.FLIGHTBOT_ADMIN_TOKEN;
  if (!token) throw new Error("FLIGHTBOT_ADMIN_TOKEN is not set");
  return token;
}

export async function GET() {
  try {
    const upstream = await fetch(`${botBaseUrl()}/status`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${botToken()}` },
      signal: AbortSignal.timeout(10000),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Upstream status failed (${upstream.status}): ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const status = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const schedule = (status.schedule ?? {}) as Record<string, unknown>;
    const runId =
      (schedule.lastRunCompletedAt as string | undefined) ??
      (schedule.lastRunStartedAt as string | undefined) ??
      (status.generatedAt as string | undefined) ??
      null;
    return NextResponse.json({ runId, status: schedule.lastRunStatus ?? null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[last-run] upstream fetch failed", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
