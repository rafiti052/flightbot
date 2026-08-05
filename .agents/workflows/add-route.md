Add a new flight route to the flightbot monitor based on: $ARGUMENTS

Example: `/add-route GRU to JFK round trip Sep 10 return Sep 20 budget 4000 BRL max 1 stop`

Your job is to parse intent; `scripts/config-route.js` performs the mutation.

1. Inspect current routes:

   ```
   node scripts/config-route.js list
   ```

2. Parse $ARGUMENTS into flags. Convert all dates to `YYYY-MM-DD`, resolving relative dates against the current date:

   | Flag | From the request | Notes |
   |------|------------------|-------|
   | `--from` / `--to` | origin / destination | IATA codes |
   | `--depart` | departure date | required |
   | `--return` | return date | omit for one-way; presence sets `roundTrip` |
   | `--budget` | maxBudget | omit if unmentioned |
   | `--stops` | maxStops | omit if unmentioned |
   | `--duration` | maxDurationHours | omit if unmentioned |
   | `--flex` | flexDays | from "±N days" / "flexible N"; defaults to 0 |
   | `--currency` | currency | defaults to BRL |
   | `--name` | route name | defaults to "AAA → BBB" |

   If origin, destination, or departure date is ambiguous, ask before proceeding.

3. Show the exact command you intend to run and ask for confirmation:

   ```
   node scripts/config-route.js add --from GRU --to JFK \
     --depart 2026-09-10 --return 2026-09-20 --budget 4000 --stops 1
   ```

4. After confirmation, run it. The script validates date formats, rejects duplicate names, and prints the added route as JSON. It exits non-zero on error — report the message rather than retrying blindly.

5. Remind the user that `config.json` is **not** synced by `/deploy` (it is live server state). To apply the new route in production, copy `config.json` up and restart the container.

Note: `--stops 0` also makes the scraper append `nonstop` to the Google Flights query, which narrows what the page renders. The post-extraction filter still enforces it.
