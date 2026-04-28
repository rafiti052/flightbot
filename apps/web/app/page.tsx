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
  if (!base) throw new Error("FLIGHTBOT_BOT_URL is not set");
  return base;
}

function botToken() {
  const token = process.env.FLIGHTBOT_ADMIN_TOKEN;
  if (!token) throw new Error("FLIGHTBOT_ADMIN_TOKEN is not set");
  return token;
}

async function fetchBotJson(pathname: string) {
  const res = await fetch(`${botBaseUrl()}${pathname}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${botToken()}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bot API ${pathname} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

export default async function HomePage() {
  await getSessionOrRedirect();
  const [cfg, status] = await Promise.all([fetchBotJson("/config"), fetchBotJson("/status")]);
  const publicCfg = cfg as Record<string, unknown>;
  const routes = publicCfg.routes as unknown;
  const routeCount = Array.isArray(routes) ? routes.length : 0;
  const masked = {
    ...publicCfg,
    anthropic: { ...(publicCfg.anthropic as object), apiKey: "••••••" },
    telegram: { ...(publicCfg.telegram as object), token: "••••••" },
  };

  return (
    <main className="container">
      <RunPoller />
      <PageHeader botBase={botBaseUrl()} revision={String(publicCfg.revision ?? "n/a")} routeCount={routeCount} />
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
