Analyze the flightbot results log. Argument: $ARGUMENTS (empty = local; "remote" = server log; "docker" = container stdout)

Run whichever matches:

```
/Users/rafael/Dev/flightbot/scripts/logs.sh                 # local results.log
/Users/rafael/Dev/flightbot/scripts/logs.sh --remote 200    # server results.log
/Users/rafael/Dev/flightbot/scripts/logs.sh --docker 200    # container stdout
```

Use `--docker` when `results.log` is empty or missing — container stdout survives independently of the bind-mounted file.

Then analyze the output:

1. Extract JSON alert records — lines starting with `{` containing a `ts` field, each with ts, route, alertType, price, airline, stops, duration. Group by route.
2. Per route, report alert prices chronologically with date and alertType (first / lower / returned), the lowest price ever alerted, and the most recent alert.
3. List lines matching `error`, `failed`, `Timed out`, or `Found 0 result` separately as **Issues**.
4. Show the first and last timestamp to indicate the monitoring window.
5. Print a summary table:

   | Route | Alerts | Best Price | Last Alert | Status |
   |-------|--------|------------|------------|--------|

   Status = "Active" if a run completed in the last 24h, else "Stale". Evaluate against the current date.

If both local and remote were requested, apply the same analysis to each and call out any differences.
