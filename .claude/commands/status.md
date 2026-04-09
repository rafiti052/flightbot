Check the operational status of the flightbot flight price monitor. Do all steps in order and report findings clearly.

1. Read `/Users/rafael/Dev/flightbot/prices.json` and `/Users/rafael/Dev/flightbot/config.json`.
   For each route in config, print a table with: route name, active status, maxBudget, lastSeenPrice from prices.json, and whether the current price is under or over budget. If prices.json has no entry for a route, show "no data yet".

2. Print the cron schedule from config.json in human-readable form (e.g. "7:00, 13:00, 20:00 daily").

3. SSH into EC2 to check container health:
   ```
   ssh -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem" -o StrictHostKeyChecking=no ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com "docker ps --filter name=flightbot --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}'"
   ```

4. Tail the last 40 lines of the remote log:
   ```
   ssh -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem" -o StrictHostKeyChecking=no ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com "tail -40 /home/ec2-user/flightbot/results.log"
   ```

5. Scan the log output for any lines containing "error", "failed", "0 result(s)", or "Timed out" (case-insensitive) and list them separately as **Issues**.

Finish with a compact summary: container health, time of last run, recent alerts fired, and any issues found.
