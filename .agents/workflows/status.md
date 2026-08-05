Check the operational status of the flightbot flight price monitor.

Run:

```
scripts/status.sh
```

It makes one server request and prints a formatted report with the container verdict, last and next run, per-route prices, budgets, and recent issues.

Relay that report directly. Do not re-derive its tables from raw log lines; the formatter already combines remote state with local `config.json`. Add commentary only when the user needs interpretation:

1. Explain any `DOWN` or `DEGRADED` verdict and its surfaced issues.
2. Note that an over-budget route with a successful scrape is correctly silent.
3. Call out missing route data or a stale/incomplete run.

Finish with a compact summary: container health, time of last run, recent alerts, and issues found.

Note when interpreting results: a run that scrapes successfully but fires no alert is **correct** when prices are above `maxBudget` — do not report that as a failure. A genuine problem looks like `Found 0 result(s)`, `Timed out waiting for flight cards`, or a container that is not `Up`.
