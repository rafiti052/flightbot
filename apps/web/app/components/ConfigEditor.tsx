"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type SaveState = {
  kind: "idle" | "ok" | "error";
  message: string;
};

export function ConfigEditor({
  initialConfig,
  initialRevision,
}: {
  initialConfig: Record<string, unknown>;
  initialRevision: number;
}) {
  const router = useRouter();
  const pretty = useMemo(() => JSON.stringify(initialConfig, null, 2), [initialConfig]);
  const [text, setText] = useState(pretty);
  const [revision, setRevision] = useState(initialRevision);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<SaveState>({ kind: "idle", message: "" });

  async function onSave() {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      setStatus({ kind: "error", message: "Invalid JSON. Fix syntax before saving." });
      return;
    }

    setSaving(true);
    setStatus({ kind: "idle", message: "" });
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed, expectedRevision: revision }),
      });
      const raw = await res.text();
      const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

      if (res.ok) {
        const nextRev = Number(payload.revision);
        if (Number.isFinite(nextRev)) setRevision(nextRev);
        setStatus({ kind: "ok", message: "Config saved successfully." });
        router.refresh();
        return;
      }

      if (res.status === 409) {
        const serverRevision = payload.revision;
        setStatus({
          kind: "error",
          message: `Conflict (409): stale revision. Server revision is ${String(serverRevision)}. Refresh and retry.`,
        });
        return;
      }

      if (res.status === 403) {
        setStatus({ kind: "error", message: "Forbidden (403): CSRF guard blocked this request." });
        return;
      }

      setStatus({
        kind: "error",
        message: `Save failed (${res.status}): ${String(payload.error ?? "Unknown error")}`,
      });
    } catch (e) {
      setStatus({ kind: "error", message: `Network error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  function onReset() {
    setText(pretty);
    setStatus({ kind: "idle", message: "" });
  }

  return (
    <section className="card">
      <div className="cardHeader">
        <h2>Config editor</h2>
        <span className="chip">revision {revision}</span>
      </div>
      <p className="muted">Edit JSON and save through the protected `/api/config` route.</p>
      <textarea
        className="editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={20}
      />
      <div className="actions">
        <button className="btn btnPrimary" onClick={onSave} disabled={saving}>
          {saving ? "Saving..." : "Save config"}
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
