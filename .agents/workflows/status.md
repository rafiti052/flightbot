Check the operational status of the flightbot flight price monitor.

Run:

```
scripts/status.sh
```

It reports container health, the last run markers, recent best prices, an issue count with samples, and live `prices.json` — all from the server.

Then read the local `config.json` and combine both into a report:

1. A table of routes: name, active, `maxBudget`, `lastSeenPrice` from `prices.json`, and whether the last seen price is under or over budget. Show "no data yet" where `prices.json` has no entry.
2. The cron `schedule` translated to human-readable local times (e.g. "8:00, 11:00, 14:00, 17:00, 20:00, 23:00 daily").
3. Any issues the script surfaced, listed separately.

Finish with a compact summary: container health, time of last run, recent alerts, and issues found.

Note when interpreting results: a run that scrapes successfully but fires no alert is **correct** when prices are above `maxBudget` — do not report that as a failure. A genuine problem looks like `Found 0 result(s)`, `Timed out waiting for flight cards`, or a container that is not `Up`.
