import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

function parseAdminAllowlist(): Set<string> {
  const raw = process.env.ADMIN_ALLOWLIST;
  if (!raw) return new Set<string>();
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set<string>(entries);
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider !== "google") {
        return false;
      }

      const googleProfile = profile as
        | { email?: string | null; email_verified?: boolean }
        | undefined;

      if (googleProfile?.email_verified !== true) {
        return false;
      }

      const email = googleProfile.email?.trim().toLowerCase();
      if (!email) {
        return false;
      }

      const allowlist = parseAdminAllowlist();
      if (allowlist.size === 0) {
        return false;
      }

      return allowlist.has(email);
    },
    async jwt({ token, user, profile }) {
      const candidateEmail =
        (user as { email?: string | null } | undefined)?.email ??
        (profile as { email?: string | null } | undefined)?.email ??
        token.email;

      if (typeof candidateEmail === "string" && candidateEmail.length > 0) {
        token.email = candidateEmail.toLowerCase();
      }

      return token;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};
