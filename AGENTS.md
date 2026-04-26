# Flight Price Monitor Bot

Node.js bot that scrapes Google Flights via Playwright, uses Codex vision (Haiku) to extract flight data from screenshots, and sends Telegram alerts when prices hit or drop below budget.

## Architecture

- `**bot.js**` — entire bot in a single file (entry point, scraping, AI extraction, alerting)
- `**config.json**` — runtime config (API keys, routes, schedule). Never commit real keys.
- `**prices.json**` — persisted price state per route. Delete to reset alert history.
- `**results.log**` — append-only log of human-readable lines + JSON alert records

## Key flow

1. `loadConfig()` reads `config.json` on startup
2. `run(config)` executes immediately and then on cron schedule
3. For each active route, `dateVariants()` expands `flexDays` into multiple departure offsets
4. `scrapeFlights()` launches headless Chromium, navigates Google Flights, takes a full-page screenshot
5. `extractFlightsFromScreenshot()` sends the screenshot to `Codex-haiku-4-5-20251001` via the Anthropic SDK and parses the JSON response
6. `evaluateAlert()` compares best price against `maxBudget` and previous alert state
7. `sendTelegram()` fires a Markdown message via the Bot API

## Alert logic (`evaluateAlert`)

- If `maxBudget` is null: alert whenever price is lower than last seen (`first` type)
- If `maxBudget` is set:
  - `first` — first time price is at or under budget
  - `lower` — price dropped below last alerted price
  - `returned` — price is still under budget but higher than last alert (came back up then dropped again)
  - Silent if price is above budget

## Config fields


| Field                       | Notes                                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| `anthropic.apiKey`          | Anthropic API key for Codex vision                                    |
| `telegram.token` / `chatId` | Telegram Bot API credentials                                          |
| `schedule`                  | Standard cron syntax                                                  |
| `routes[].flexDays`         | Expands departure date ±N days; each variant is scraped separately    |
| `routes[].maxBudget`        | If set, enables budget-aware alerting; if null, alerts on any new low |
| `routes[].maxStops`         | Filter applied post-extraction; null = no filter                      |
| `routes[].maxDurationHours` | Filter applied post-extraction; null = no filter                      |


## Running

```bash
npm install && npm run install-browsers
node bot.js
```

## Docker

```bash
docker-compose up -d
```

## Dependencies

- `playwright` — headless Chromium scraping
- `@anthropic-ai/sdk` — Codex vision for flight extraction
- `node-cron` — schedule

## Notes

- Rate limiting: 3–6s random delay between date variants; 5s between routes
- Filters (`maxStops`, `maxDurationHours`) are applied after Codex extraction, not at scrape time
- `prices.json` uses route `name` as key — changing a route name resets its alert history
- The bot uses `Codex-haiku-4-5-20251001` for cost efficiency on vision tasks

