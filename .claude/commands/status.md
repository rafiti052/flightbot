Check the operational status of the flightbot flight price monitor. Do all steps in order and report findings clearly.

1. Read `/Users/rafael/Dev/flightbot/prices.json` and `/Users/rafael/Dev/flightbot/config.json`.
   For each route in config, print a table with: route name, active status, maxBudget, lastSeenPrice from prices.json, and whether the current price is under or over budget. If prices.json has no entry for a route, show "no data yet".

2. Print the cron schedule from config.json in human-readable form (e.g. "7:00, 13:00, 20:00 daily").

3. SSH into EC2 to check container health. Connection details (`SSH_KEY_PATH`, `SSH_USER`, `SSH_HOST`) come from `.env`; source it first since each command runs in a fresh shell:
   ```
   source /Users/rafael/Dev/flightbot/.env && ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" "docker ps --filter name=flightbot --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}'"
   ```

4. Tail the last 40 lines of the remote log:
   ```
   source /Users/rafael/Dev/flightbot/.env && ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" "tail -40 /home/ec2-user/flightbot/results.log"
   ```

5. Scan the log output for any lines containing "error", "failed", "0 result(s)", or "Timed out" (case-insensitive) and list them separately as **Issues**.

Finish with a compact summary: container health, time of last run, recent alerts fired, and any issues found.
