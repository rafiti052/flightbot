Analyze the flightbot results log. Argument: $ARGUMENTS (empty = local only; "remote" = also tail EC2 log)

**Local log analysis:**

1. Read `/Users/rafael/Dev/flightbot/results.log`.

2. Extract all JSON alert records — lines that start with `{` and contain a `ts` field. Each has: ts, route, alertType, price, airline, stops, duration. Parse and group by route name.

3. For each route, show:
   - All alert prices in chronological order with date and alertType (first / lower / returned)
   - Lowest price ever alerted
   - Most recent alert

4. Separately list all log lines containing "error", "failed", "0 result(s)", or "Timed out" as **Issues**.

5. Show the first and last timestamp in the log to indicate the monitoring window.

6. Print a summary table:

   | Route | Alerts | Best Price | Last Alert | Status |
   |-------|--------|------------|------------|--------|

   Status = "Active" if a run completed in the last 24h, "Stale" otherwise. Use the current date to evaluate.

**If $ARGUMENTS contains "remote":**

Additionally SSH and tail the remote log:
```
ssh -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem" -o StrictHostKeyChecking=no ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com "tail -60 /home/ec2-user/flightbot/results.log"
```
Then apply the same structured analysis to the remote output and show if it differs from the local log.
