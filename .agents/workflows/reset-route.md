Reset or pause a flightbot route based on: $ARGUMENTS

Interpret the intent, then delegate the mutation to `scripts/config-route.js`:

| Intent | Command |
|--------|---------|
| "reset X" / "clear X" | `node scripts/config-route.js reset "X"` — clears price history so the next scrape treats it as fresh |
| "pause X" / "disable X" | `node scripts/config-route.js pause "X"` |
| "resume X" / "enable X" | `node scripts/config-route.js resume "X"` |
| empty / "all" | `node scripts/config-route.js list`, show the table, then ask what to do |

All paths are relative to the repo root.

**Steps:**

1. Always start with `list` and print a table:

   | Route | Active | maxBudget | Depart | Return | lastSeenPrice | lastAlertPrice |
   |-------|--------|-----------|--------|--------|---------------|----------------|

2. Run the matching command. Route names contain a `→`, so always quote them. The script validates the name against `config.json` and lists valid names if it doesn't match — surface that message rather than guessing.

3. Report what changed, using the script's JSON output:
   - **reset** — confirm history cleared and note that the next scrape will alert if price ≤ `maxBudget`. `prices.json` is bind-mounted, so no container restart is needed; the file just needs to reach the server.
   - **pause / resume** — note that `config.json` changes require a container restart on EC2 to take effect.

4. Offer to push the changed file to production and, for `config.json` changes, restart:

   ```
   scripts/deploy.sh
   ```

   Note `deploy.sh` deliberately does **not** sync `config.json` or `prices.json` — copy those explicitly when the user wants them applied in production.
