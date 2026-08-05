Run a full smoke test of the flightbot scraping pipeline for route: $ARGUMENTS

Choose local or production:

```
node /Users/rafael/Dev/flightbot/scripts/test-scrape.js "$ARGUMENTS"      # local checkout
/Users/rafael/Dev/flightbot/scripts/remote-test.sh "$ARGUMENTS"           # deployed container
```

Default to the local run unless the user says "prod", "production", or "remote". Empty `$ARGUMENTS` tests the first active route; a route name (e.g. `"GRU → FLN"`) tests that one. Quote the name — route names contain `→`.

The script scrapes Google Flights, switches to the **Cheapest** tab, expands the result list, flattens sticky elements, sends the screenshot to Claude Haiku, applies filters, and sends a `[TEST]` Telegram message.

Steps:

1. Run the appropriate command.
2. For a local run, display `/Users/rafael/Dev/flightbot/test-screenshot.png` visually so the page render can be inspected. (The remote run may not persist a screenshot — rely on log output there.)
3. Report:
   - URL fetched (confirm it contains `nonstop` when the route sets `maxStops: 0`)
   - Whether `Sorted by cheapest` appears — if not, the Cheapest tab selector needs attention
   - Raw flights extracted (count)
   - Flights passing filters (count + the filter values used)
   - Best flight: airline, price, stops, times
   - Whether the Telegram message sent

4. If 0 flights were extracted:
   - Show the raw Claude response between the `--- Claude raw response ---` markers
   - Inspect the screenshot: real results page, CAPTCHA, cookie wall, or empty?
   - Page looks right but extraction failed → the prompt in `scraper.js` → `extractFlightsFromScreenshot()` needs adjustment
   - Truncated JSON → raise `max_tokens` in `scraper.js`
   - CAPTCHA or empty results → bot detection; suggest retrying later or revisiting the User-Agent / locale
   - Departure dates in the past also produce empty pages — check the route dates against today

5. Finish with a one-line verdict.

Important: the script exits non-zero when no flight passes the filters, but that is **not** necessarily a scraper failure — if flights were extracted and simply exceeded `maxBudget` or the duration cap, the pipeline worked correctly. Say so explicitly, and report the cheapest flight seen for comparison against the budget.
