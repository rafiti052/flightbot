Run a full smoke test of the flightbot scraping pipeline for route: $ARGUMENTS

Choose local or production:

```
node scripts/test-scrape.js "$ARGUMENTS" --json      # local checkout
scripts/remote-test.sh "$ARGUMENTS" --json           # deployed container
```

Default to the local run unless the user says "prod", "production", or "remote". Empty `$ARGUMENTS` tests the first active route; a route name (e.g. `"GRU → FLN"`) tests that one. Quote the name — route names contain `→`.

The script scrapes Google Flights, switches to the **Cheapest** tab, expands the result list, flattens sticky elements, sends the screenshot to Claude Haiku, applies filters, and sends a `[TEST]` Telegram message. Pass `--no-send` when the user wants a dry run, and `-v` without `--json` for the raw Claude response.

Steps:

1. Run the appropriate command.
2. For a local run, display `test-screenshot.png` visually so the page render can be inspected. (The remote run may not persist a screenshot — rely on log output there.)
3. Read the single JSON object and report:
   - `route.url` (confirm it contains `nonstop` when the route sets `maxStops: 0`)
   - the `sort` and `expand` entries in `stages`
   - `filters.extracted`, `filters.passed`, and the configured filter values
   - the first entry in `flights`: airline, price, stops, times
   - `telegram.status`

4. If 0 flights were extracted:
   - Inspect `rawText`
   - Inspect the screenshot: real results page, CAPTCHA, cookie wall, or empty?
   - Page looks right but extraction failed → the prompt in `scraper.js` → `extractFlightsFromScreenshot()` needs adjustment
   - Truncated JSON → raise `max_tokens` in `scraper.js`
   - CAPTCHA or empty results → bot detection; suggest retrying later or revisiting the User-Agent / locale
   - Departure dates in the past also produce empty pages — check the route dates against today

5. Finish with a one-line verdict.

Important: the script exits non-zero when no flight passes the filters, but that is **not** necessarily a scraper failure — if flights were extracted and simply exceeded `maxBudget` or the duration cap, the pipeline worked correctly. Say so explicitly, and report the cheapest flight seen for comparison against the budget.
