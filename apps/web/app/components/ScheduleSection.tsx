"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  guidedScheduleToCron,
  parseGuidedScheduleFromCron,
  type GuidedScheduleState,
  type ScheduleMode,
} from "@/lib/scheduleGuided";

type SaveState = {
  kind: "idle" | "ok" | "error";
  message: string;
};

export function ScheduleSection({
  schedule,
  initialConfig,
  initialRevision,
}: {
  schedule: string;
  initialConfig: Record<string, unknown>;
  initialRevision: number;
}) {
  const router = useRouter();
  const parsedInitial = useMemo(() => parseGuidedScheduleFromCron(schedule), [schedule]);
  const [mode, setMode] = useState<ScheduleMode>(parsedInitial.mode);
  const [time, setTime] = useState(parsedInitial.time);
  const [intervalHours, setIntervalHours] = useState(parsedInitial.intervalHours);
  const [cron, setCron] = useState(schedule);
  const [revision, setRevision] = useState(initialRevision);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<SaveState>({ kind: "idle", message: "" });

  const guidedSummary = useMemo(() => {
    if (mode === "custom") return "Custom cron schedule in use.";
    const cronFromGuided = guidedScheduleToCron(mode, time, intervalHours);
    return parseGuidedScheduleFromCron(cronFromGuided ?? "").summary;
  }, [intervalHours, mode, time]);

  const scheduleChanged = cron !== schedule;
  const restartRequired = scheduleChanged;

  function applyGuided(nextMode: ScheduleMode, nextTime: string, nextInterval: number) {
    const generated = guidedScheduleToCron(nextMode, nextTime, nextInterval);
    if (!generated) return;
    setCron(generated);
  }

  function onModeChange(nextMode: ScheduleMode) {
    setMode(nextMode);
    applyGuided(nextMode, time, intervalHours);
  }

  function onTimeChange(nextTime: string) {
    setTime(nextTime);
    applyGuided(mode, nextTime, intervalHours);
  }

  function onIntervalChange(raw: string) {
    const nextInterval = Math.max(1, Math.min(23, Number(raw) || 1));
    setIntervalHours(nextInterval);
    applyGuided(mode, time, nextInterval);
  }

  function onCronChange(nextCron: string) {
    setCron(nextCron);
    const parsed = parseGuidedScheduleFromCron(nextCron);
    setMode(parsed.mode);
    setTime(parsed.time);
    setIntervalHours(parsed.intervalHours);
  }

  function onReset() {
    const reset = parseGuidedScheduleFromCron(schedule);
    setMode(reset.mode);
    setTime(reset.time);
    setIntervalHours(reset.intervalHours);
    setCron(schedule);
    setStatus({ kind: "idle", message: "" });
  }

  async function onSave() {
    setSaving(true);
    setStatus({ kind: "idle", message: "" });
    try {
      const payload = {
        ...initialConfig,
        schedule: cron,
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
        setStatus({ kind: "ok", message: "Schedule saved successfully." });
        router.refresh();
        return;
      }

      if (res.status === 409) {
        setStatus({
          kind: "error",
          message: `Conflict (409): stale revision. Server revision is ${String(data.revision)}. Refresh and retry.`,
        });
        return;
      }

      if (res.status === 403) {
        setStatus({ kind: "error", message: "Forbidden (403): CSRF guard blocked this request." });
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
        <h2>Schedule</h2>
        <span className="chip">revision {revision}</span>
      </div>
      <p className="muted">Use guided controls for common patterns, or edit cron directly for advanced schedules.</p>
      <div style={{ marginTop: 10, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <label>
          Pattern
          <select className="editor" style={{ marginTop: 4 }} value={mode} onChange={(e) => onModeChange(e.target.value as ScheduleMode)}>
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="every-hours">Every X hours</option>
            <option value="custom">Custom cron</option>
          </select>
        </label>
        <label>
          Run time
          <input
            className="editor"
            style={{ marginTop: 4 }}
            type="time"
            value={time}
            disabled={mode === "custom"}
            onChange={(e) => onTimeChange(e.target.value)}
          />
        </label>
        <label>
          Interval (hours)
          <input
            className="editor"
            style={{ marginTop: 4 }}
            type="number"
            min={1}
            max={23}
            step={1}
            value={intervalHours}
            disabled={mode !== "every-hours"}
            onChange={(e) => onIntervalChange(e.target.value)}
          />
        </label>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        {guidedSummary}
      </p>
      <label style={{ display: "block", marginTop: 10 }}>
        Advanced cron expression
        <input
          className="editor"
          style={{ marginTop: 4 }}
          type="text"
          placeholder="0 7,13,20 * * *"
          value={cron}
          onChange={(e) => onCronChange(e.target.value)}
        />
      </label>
      {restartRequired ? (
        <p className="notice noticeErr">Restart required after save. Schedule differs from the currently loaded config.</p>
      ) : null}
      <div className="actions">
        <button className="btn btnPrimary" onClick={onSave} disabled={saving}>
          {saving ? "Saving..." : "Save schedule"}
        </button>
        <button className="btn" onClick={onReset} disabled={saving}>
          Reset
        </button>
      </div>
      {status.message ? (
        <p className={status.kind === "ok" ? "notice noticeOk" : "notice noticeErr"}>{status.message}</p>
      ) : null}
    </section>
  );
}
