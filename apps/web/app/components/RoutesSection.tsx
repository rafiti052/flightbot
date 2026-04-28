"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type SaveState = {
  kind: "idle" | "ok" | "error";
  message: string;
};

type RouteItem = {
  name?: string;
  from?: string;
  to?: string;
  active?: boolean;
  departureDate?: string;
  returnDate?: string;
  currency?: string;
  maxBudget?: number | null;
  flexDays?: number;
  maxStops?: number | null;
  maxDurationHours?: number | null;
};

function normalizeRoute(raw: unknown): RouteItem {
  const route = (raw ?? {}) as Record<string, unknown>;
  return {
    name: String(route.name ?? ""),
    from: String(route.from ?? ""),
    to: String(route.to ?? ""),
    active: route.active !== false,
    departureDate: String(route.departureDate ?? ""),
    returnDate: String(route.returnDate ?? ""),
    currency: String(route.currency ?? "USD"),
    maxBudget: typeof route.maxBudget === "number" ? route.maxBudget : null,
    flexDays: Number.isFinite(Number(route.flexDays)) ? Number(route.flexDays) : 0,
    maxStops: typeof route.maxStops === "number" ? route.maxStops : null,
    maxDurationHours: typeof route.maxDurationHours === "number" ? route.maxDurationHours : null,
  };
}

export function RoutesSection({
  routes,
  routeCount,
  initialConfig,
  initialRevision,
}: {
  routes: unknown;
  routeCount: number;
  initialConfig: Record<string, unknown>;
  initialRevision: number;
}) {
  const router = useRouter();
  const initialRoutes = useMemo(
    () => (Array.isArray(routes) ? routes.map(normalizeRoute) : []),
    [routes]
  );
  const [routeList, setRouteList] = useState<RouteItem[]>(initialRoutes);
  const [selected, setSelected] = useState(0);
  const [revision, setRevision] = useState(initialRevision);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<SaveState>({ kind: "idle", message: "" });

  const activeCount = routeList.filter((route) => route.active !== false).length;
  const current = routeList[selected];
  const currentInitialName =
    selected >= 0 && selected < initialRoutes.length ? String(initialRoutes[selected]?.name ?? "") : "";
  const routeRenamed =
    Boolean(currentInitialName) &&
    Boolean(current?.name?.trim()) &&
    current?.name?.trim() !== currentInitialName;
  const hasHighFlexDays = routeList.some((route) => Number(route.flexDays ?? 0) > 3);

  function validateRoutes() {
    for (let idx = 0; idx < routeList.length; idx += 1) {
      const route = routeList[idx];
      const missing = [];
      if (!route.name?.trim()) missing.push("name");
      if (!route.from?.trim()) missing.push("from");
      if (!route.to?.trim()) missing.push("to");
      if (missing.length) {
        return `Route ${idx + 1} is missing required field(s): ${missing.join(", ")}.`;
      }
    }
    return null;
  }

  function updateCurrent(update: Partial<RouteItem>) {
    setRouteList((prev) => prev.map((route, idx) => (idx === selected ? { ...route, ...update } : route)));
  }

  function addRoute() {
    const next: RouteItem = {
      name: "New route",
      from: "",
      to: "",
      active: true,
      departureDate: "",
      returnDate: "",
      currency: "USD",
      maxBudget: null,
      flexDays: 0,
      maxStops: null,
      maxDurationHours: null,
    };
    setRouteList((prev) => [...prev, next]);
    setSelected(routeList.length);
  }

  function duplicateRoute() {
    if (!current) return;
    const copy = { ...current, name: `${current.name || "Route"} (copy)` };
    setRouteList((prev) => [...prev, copy]);
    setSelected(routeList.length);
  }

  function deleteRoute() {
    if (!current) return;
    const next = routeList.filter((_, idx) => idx !== selected);
    setRouteList(next);
    setSelected(Math.max(0, Math.min(selected, next.length - 1)));
  }

  async function saveRoutes() {
    const validationError = validateRoutes();
    if (validationError) {
      setStatus({ kind: "error", message: validationError });
      return;
    }

    setSaving(true);
    setStatus({ kind: "idle", message: "" });
    try {
      const payload = {
        ...initialConfig,
        routes: routeList,
        expectedRevision: revision,
      };
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const raw = await res.text();
      const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

      if (res.ok) {
        const nextRev = Number(data.revision);
        if (Number.isFinite(nextRev)) setRevision(nextRev);
        setStatus({ kind: "ok", message: "Routes saved successfully." });
        router.refresh();
        return;
      }

      if (res.status === 409) {
        setStatus({
          kind: "error",
          message: `Conflict (409): stale revision. Server revision is ${String(data.revision)}.`,
        });
        return;
      }

      setStatus({
        kind: "error",
        message: `Save failed (${res.status}): ${String(data.error ?? "Unknown error")}`,
      });
    } catch (e) {
      setStatus({ kind: "error", message: `Network error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <div className="cardHeader">
        <h2>Routes</h2>
        <span className="chip">revision {revision}</span>
      </div>
      <p className="muted">
        Active routes: <strong>{activeCount}</strong> / <strong>{routeCount}</strong>
      </p>
      <div className="actions">
        <button className="btn btnPrimary" onClick={addRoute} disabled={saving}>
          Add route
        </button>
        <button className="btn" onClick={duplicateRoute} disabled={saving || !current}>
          Duplicate
        </button>
        <button className="btn" onClick={deleteRoute} disabled={saving || !current}>
          Delete
        </button>
      </div>
      {routeList.length ? (
        <>
          <label style={{ display: "block", marginTop: 8 }}>
            Select route
            <select
              className="editor"
              value={selected}
              onChange={(e) => setSelected(Number(e.target.value))}
              style={{ marginTop: 4 }}
            >
              {routeList.map((route, idx) => (
                <option key={`${route.name || "route"}-${idx}`} value={idx}>
                  {route.name || `Route ${idx + 1}`}
                </option>
              ))}
            </select>
          </label>
          <div style={{ marginTop: 10, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <label>
              Name
              <input className="editor" value={current?.name ?? ""} onChange={(e) => updateCurrent({ name: e.target.value })} />
            </label>
            <label>
              From
              <input className="editor" value={current?.from ?? ""} onChange={(e) => updateCurrent({ from: e.target.value.toUpperCase() })} />
            </label>
            <label>
              To
              <input className="editor" value={current?.to ?? ""} onChange={(e) => updateCurrent({ to: e.target.value.toUpperCase() })} />
            </label>
            <label>
              Currency
              <input className="editor" value={current?.currency ?? ""} onChange={(e) => updateCurrent({ currency: e.target.value.toUpperCase() })} />
            </label>
            <label>
              Max budget
              <input
                className="editor"
                type="number"
                value={current?.maxBudget ?? ""}
                onChange={(e) => updateCurrent({ maxBudget: e.target.value ? Number(e.target.value) : null })}
              />
            </label>
            <label>
              Flex days
              <input
                className="editor"
                type="number"
                min={0}
                max={7}
                value={current?.flexDays ?? 0}
                onChange={(e) => updateCurrent({ flexDays: Math.max(0, Number(e.target.value) || 0) })}
              />
            </label>
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <input
              type="checkbox"
              checked={current?.active !== false}
              onChange={(e) => updateCurrent({ active: e.target.checked })}
            />
            Route active
          </label>
          {routeRenamed ? (
            <p className="notice noticeErr" style={{ marginTop: 10 }}>
              Renaming this route may reset historical price tracking tied to route name.
            </p>
          ) : null}
          {hasHighFlexDays ? (
            <p className="notice noticeErr" style={{ marginTop: 10 }}>
              One or more routes use high flex days. This can increase scrape volume and runtime costs.
            </p>
          ) : null}
        </>
      ) : (
        <p className="muted">No routes configured yet. Add one to get started.</p>
      )}
      <div className="actions">
        <button className="btn btnPrimary" onClick={saveRoutes} disabled={saving}>
          {saving ? "Saving..." : "Save routes"}
        </button>
      </div>
      {status.message ? (
        <p className={status.kind === "ok" ? "notice noticeOk" : "notice noticeErr"}>{status.message}</p>
      ) : null}
    </section>
  );
}
