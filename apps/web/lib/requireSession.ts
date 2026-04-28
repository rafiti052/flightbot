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

export default async function requireSession(): Promise<Session> {
  const session = await getServerSession(authOptions);
  if (!session) {
    throw new UnauthorizedError();
  }
  return session;
}

export type SessionOr401 =
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse };

export async function getSessionOr401Response(): Promise<SessionOr401> {
  const session = await getServerSession(authOptions);
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
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect(target);
  }
  return session;
}
