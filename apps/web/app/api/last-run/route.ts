import { NextResponse } from "next/server";
import { readLastRunMarker } from "@flightbot/shared";

export const dynamic = "force-dynamic";

function dataDir() {
  const d = process.env.FLIGHTBOT_DATA_DIR;
  if (!d) throw new Error("FLIGHTBOT_DATA_DIR is not set");
  return d;
}

export async function GET() {
  try {
    const marker = readLastRunMarker(dataDir());
    return NextResponse.json(marker ?? {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
