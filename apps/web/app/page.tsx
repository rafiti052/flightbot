import { getSessionOrRedirect } from "@/lib/requireSession";
import { ConfigMaskedSection } from "./components/ConfigMaskedSection";
import { ConfigEditor } from "./components/ConfigEditor";
import { PageHeader } from "./components/PageHeader";
import { RoutesSection } from "./components/RoutesSection";
import { RunPoller } from "./components/RunPoller";
import { ScheduleSection } from "./components/ScheduleSection";
import { StatusSection } from "./components/StatusSection";

export const dynamic = "force-dynamic";

function botBaseUrl() {
  const base = process.env.FLIGHTBOT_BOT_URL?.replace(/\/$/, "");
  return base || null;
}

function botToken() {
  const token = process.env.FLIGHTBOT_ADMIN_TOKEN;
  return token || null;
}

async function fetchBotJson(pathname: string) {
  const base = botBaseUrl();
  const token = botToken();
  if (!base || !token) {
    throw new Error(
      [
        "Bot backend is not configured.",
        base ? null : "Missing FLIGHTBOT_BOT_URL.",
        token ? null : "Missing FLIGHTBOT_ADMIN_TOKEN.",
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  const res = await fetch(`${botBaseUrl()}${pathname}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bot API ${pathname} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

export default async function HomePage() {
  await getSessionOrRedirect();
  let publicCfg: Record<string, unknown> = {};
  let status: Record<string, unknown> = {};
  let botError: string | null = null;

  try {
    const [cfg, st] = await Promise.all([fetchBotJson("/config"), fetchBotJson("/status")]);
    publicCfg = cfg as Record<string, unknown>;
    status = st as Record<string, unknown>;
  } catch (e) {
    botError = e instanceof Error ? e.message : String(e);
  }

  const routes = publicCfg.routes as unknown;
  const routeCount = Array.isArray(routes) ? routes.length : 0;
  const masked =
    publicCfg && typeof publicCfg === "object"
      ? {
          ...publicCfg,
          anthropic: { ...(publicCfg.anthropic as object), apiKey: "••••••" },
          telegram: { ...(publicCfg.telegram as object), token: "••••••" },
        }
      : publicCfg;

  return (
    <main className="container">
      <RunPoller />
      {botError ? (
        <p className="notice noticeErr" style={{ marginTop: 10 }}>
          {botError}
        </p>
      ) : null}
      <PageHeader
        botBase={botBaseUrl() ?? ""}
        revision={String(publicCfg.revision ?? "n/a")}
        routeCount={routeCount}
      />
      <ScheduleSection
        schedule={String(publicCfg.schedule ?? "")}
        initialConfig={publicCfg}
        initialRevision={Number(publicCfg.revision ?? 0)}
      />
      <RoutesSection
        routes={routes}
        routeCount={routeCount}
        initialConfig={publicCfg}
        initialRevision={Number(publicCfg.revision ?? 0)}
      />
      <ConfigMaskedSection maskedConfig={masked} />
      <ConfigEditor initialConfig={publicCfg} initialRevision={Number(publicCfg.revision ?? 0)} />
      <StatusSection status={status} />
    </main>
  );
}
