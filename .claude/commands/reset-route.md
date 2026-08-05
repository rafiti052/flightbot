Reset or pause a flightbot route based on: $ARGUMENTS

Interpret the intent:
- "reset [name]" or "clear [name]" → clear that route's price history from prices.json (next scrape treats it as fresh)
- "pause [name]" or "disable [name]" → set active: false in config.json
- "resume [name]" or "enable [name]" → set active: true in config.json
- empty or "all" → show current state of all routes and ask what to do

**Steps:**

1. Read `/Users/rafael/Dev/flightbot/prices.json` and `/Users/rafael/Dev/flightbot/config.json`. Print a table:

   | Route | Active | maxBudget | lastAlertPrice | lastAlertAt | lastSeenPrice | lastSeenAt |
   |-------|--------|-----------|----------------|-------------|---------------|------------|

2. **If resetting price history:**
   - Remove the route's key from prices.json
   - Write the updated prices.json
   - Confirm: "Price history cleared for [route]. Next scrape will treat it as fresh and alert if price ≤ maxBudget."
   - Offer to sync prices.json to EC2 immediately (volume-mounted — no container restart needed). Connection details (`SSH_KEY_PATH`, `SSH_USER`, `SSH_HOST`) come from `.env`; source it first since each command runs in a fresh shell:
     ```
     source /Users/rafael/Dev/flightbot/.env && rsync -avz -e "ssh -o StrictHostKeyChecking=no -i \"$SSH_KEY_PATH\"" /Users/rafael/Dev/flightbot/prices.json "$SSH_USER@$SSH_HOST:/home/ec2-user/flightbot/prices.json"
     ```

3. **If pausing a route:**
   - Set `active: false` on the matching route in config.json and write the file
   - Remind the user: config.json changes require a container restart on EC2 to take effect

4. **If resuming a route:**
   - Set `active: true` on the matching route in config.json and write the file
   - Same reminder about container restart

5. For config.json changes, offer to push and restart:
   ```
   source /Users/rafael/Dev/flightbot/.env && rsync -avz -e "ssh -o StrictHostKeyChecking=no -i \"$SSH_KEY_PATH\"" /Users/rafael/Dev/flightbot/config.json "$SSH_USER@$SSH_HOST:/home/ec2-user/flightbot/config.json"
   source /Users/rafael/Dev/flightbot/.env && ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" "cd /home/ec2-user/flightbot && docker-compose restart"
   ```
