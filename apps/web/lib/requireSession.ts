import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

function devBypassSession(): Session | null {
  if (process.env.NODE_ENV === "production") return null;
  if (process.env.DEV_AUTH_BYPASS !== "true") return null;

  const email = process.env.DEV_AUTH_EMAIL?.trim().toLowerCase();
  if (!email) {
    throw new UnauthorizedError("DEV_AUTH_BYPASS requires DEV_AUTH_EMAIL");
  }

  return {
    user: {
      email,
      name: process.env.DEV_AUTH_NAME?.trim() || email,
    },
    expires: "2099-12-31T23:59:59.999Z",
  };
}

async function getResolvedSession(): Promise<Session | null> {
  const bypass = devBypassSession();
  if (bypass) {
    return bypass;
  }

  return getServerSession(authOptions);
}

export default async function requireSession(): Promise<Session> {
  const session = await getResolvedSession();
  if (!session) {
    throw new UnauthorizedError();
  }
  return session;
}

export type SessionOr401 =
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse };

export async function getSessionOr401Response(): Promise<SessionOr401> {
  const session = await getResolvedSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, session };
}

export async function getSessionOrRedirect(
  target = "/api/auth/signin",
): Promise<Session> {
  const session = await getResolvedSession();
  if (!session) {
    redirect(target);
  }
  return session;
}
