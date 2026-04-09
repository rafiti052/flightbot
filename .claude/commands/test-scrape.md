Run a full smoke test of the flightbot scraping pipeline for route: $ARGUMENTS

Steps:

1. Run the smoke test:
   ```
   node /Users/rafael/Dev/flightbot/test-run.js "$ARGUMENTS"
   ```
   If $ARGUMENTS is empty, it tests the first active route. If a route name is provided (e.g. "GRU → LIS"), it tests that specific route. The script will scrape Google Flights via Playwright, send the screenshot to Claude Haiku for extraction, apply filters, and send a [TEST] Telegram message.

2. Display the screenshot at `/Users/rafael/Dev/flightbot/test-screenshot.png` visually so the page render can be inspected.

3. Parse the console output and report:
   - URL that was fetched
   - Raw flights extracted by Claude (count)
   - Flights that passed filters (count + filter values used)
   - Best flight found: airline, price, stops, departure/arrival times
   - Whether the Telegram message was sent successfully

4. If 0 flights were extracted by Claude:
   - Show the raw Claude response from stdout (between the "--- Claude raw response ---" markers)
   - Visually inspect the screenshot: does it show a Google Flights results page with flight cards, a CAPTCHA, a cookie wall, or something else?
   - If the page looks correct but extraction failed, the prompt in `bot.js` → `extractFlightsFromScreenshot()` may need adjustment
   - If the page shows a CAPTCHA or empty results, the scraper hit bot detection — suggest waiting and retrying, or checking the User-Agent/locale settings

5. Finish with a one-line verdict: "Scraper OK — extracted N flights, best price X BRL, Telegram sent." or a clear failure summary.
