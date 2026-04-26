"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export function RunPoller() {
  const router = useRouter();
  const lastRunId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const res = await fetch("/api/last-run", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled || !data?.runId) return;
        if (lastRunId.current && lastRunId.current !== data.runId) {
          router.refresh();
        }
        lastRunId.current = data.runId;
      } catch {
        // ignore transient fetch errors
      }
    }

    void tick();
    const id = setInterval(() => void tick(), 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [router]);

  return null;
}
