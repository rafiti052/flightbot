import { getSessionOrRedirect } from "@/lib/requireSession";
import { ConfigEditor } from "./components/ConfigEditor";
import { RunPoller } from "./components/RunPoller";

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
      <h1>Flightbot dashboard</h1>
      <p className="muted">
        Bot base: <code>{botBaseUrl()}</code> — config revision <strong>{String(publicCfg.revision ?? "n/a")}</strong>,{" "}
        <strong>{routeCount}</strong> route(s).
      </p>
      <section className="card">
        <h2>Schedule</h2>
        <pre>{String(publicCfg.schedule ?? "")}</pre>
      </section>
      <section className="card">
        <h2>Config (masked)</h2>
        <pre>{JSON.stringify(masked, null, 2)}</pre>
      </section>
      <ConfigEditor initialConfig={publicCfg} initialRevision={Number(publicCfg.revision ?? 0)} />
      <section className="card">
        <h2>Status</h2>
        <pre>{JSON.stringify(status, null, 2)}</pre>
      </section>
    </main>
  );
}
