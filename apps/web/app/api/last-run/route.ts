import { NextResponse } from "next/server";
import { getSessionOr401Response } from "@/lib/requireSession";

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
  const auth = await getSessionOr401Response();
  if (!auth.ok) return auth.response;

  try {
    const upstream = await fetch(`${botBaseUrl()}/status`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${botToken()}` },
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Upstream status failed (${upstream.status})` },
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
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
