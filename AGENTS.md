# Flight Price Monitor Bot

Node.js bot that scrapes Google Flights via Playwright, uses Claude vision (Haiku) to extract flight data from screenshots, and sends Telegram alerts when prices hit or drop below budget.

## Architecture

- **`bot.js`** — entry point: config loading, cron scheduling, alert evaluation, Telegram delivery, logging
- **`scraper.js`** — shared scrape path: URL building, Playwright page prep/capture, Claude vision extraction, filtering. Imported by both `bot.js` and `scripts/test-scrape.js` so the smoke test exercises the same code production runs.
- **`.env`** — secrets and account identifiers (`ANTHROPIC_KEY`, `TELEGRAM_KEY`, `TELEGRAM_CHAT_ID`) plus deploy SSH vars (`SSH_KEY_PATH`, `SSH_USER`, `SSH_HOST`). Gitignored, never commit real keys. See `.env.example`.
- **`config.json`** — runtime config (routes, schedule) only. No secrets or account IDs.
- **`scripts/`** — deterministic shell/node scripts backing the operational workflows in `.agents/workflows/`.
- **`prices.json`** — persisted price state per route. Delete to reset alert history.
- **`results.log`** — append-only log of human-readable lines + JSON alert records

## Key flow

1. `loadConfig()` loads `.env` (via `process.loadEnvFile`), reads `config.json`, and injects `ANTHROPIC_KEY`/`TELEGRAM_KEY`/`TELEGRAM_CHAT_ID` into `config.anthropic.apiKey` / `config.telegram.token` / `config.telegram.chatId`. It throws if any of the three is missing.
2. `run(config)` executes immediately and then on cron schedule
3. For each active route, `dateVariants()` expands `flexDays` into multiple departure offsets
4. `captureFlightsScreenshot()` (scraper.js) launches headless Chromium, navigates Google Flights, switches to the **Cheapest** tab, expands "View more flights", flattens sticky/fixed elements, and takes a full-page screenshot
5. `extractFlightsFromScreenshot()` sends the screenshot to `claude-haiku-4-5-20251001` via the Anthropic SDK and returns `{ flights, rawText, parseError }`
6. `evaluateAlert()` compares best price against `maxBudget` and previous alert state
7. `sendTelegram()` fires a Markdown message via the Bot API

## Alert logic (`evaluateAlert`)

- If `maxBudget` is null: alert whenever price is lower than last seen (`first` type)
- If `maxBudget` is set:
  - `first` — first time price is at or under budget
  - `lower` — price dropped below last alerted price
  - `returned` — price is still under budget but higher than last alert (came back up then dropped again)
  - Silent if price is above budget

## Secrets (`.env`)

| Var | Notes |
|-----|-------|
| `ANTHROPIC_KEY` | Anthropic API key for Claude vision |
| `TELEGRAM_KEY` | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID to send alerts to |
| `SSH_KEY_PATH` / `SSH_USER` / `SSH_HOST` | EC2 deploy target, used by `scripts/lib/common.sh` |

## Config fields (`config.json`)

| Field | Notes |
|-------|-------|
| `schedule` | Standard cron syntax |
| `routes[].flexDays` | Expands departure date ±N days; each variant is scraped separately |
| `routes[].maxBudget` | If set, enables budget-aware alerting; if null, alerts on any new low |
| `routes[].maxStops` | Filter applied post-extraction; null = no filter |
| `routes[].maxDurationHours` | Filter applied post-extraction; null = no filter |

## Running

```bash
pnpm install && pnpm run install-browsers
node bot.js
```

## Docker

```bash
docker-compose up -d
```

## Dependencies

- `playwright` — headless Chromium scraping
- `@anthropic-ai/sdk` — Claude vision for flight extraction
- `node-cron` — schedule

## Operational workflows

Canonical definitions live in `.agents/workflows/`. Claude Code and Cursor expose them as slash
commands via symlinks in `.claude/commands/` and `.cursor/commands/`. Other tools should read
the workflow file directly and run the `scripts/` command it names.

## Agent skills

Canonical skill definitions live in `.agents/skills/`. Agent-specific skill directories expose
them through relative symlinks; never maintain copied skill trees under `.claude/`, `.cursor/`,
or `.windsurf/`.

## Terminal output

- `ui.js` owns the terminal design roles, glyph fallbacks, width-aware tables, money and
  duration formatting, and TTY-only progress behavior. Reuse its semantic helpers instead
  of embedding ANSI codes in callers.
- Interactive TTY runs use the formatted view. Non-TTY stdout (Docker, CI, and pipes) keeps
  the timestamped plain-log shape used by operational tooling.
- `NO_COLOR` disables ANSI styling. `FORCE_COLOR` enables it unless set to `0`.
- `results.log` is never colorized. Its wording and JSON alert lines are a parsed public
  contract; update every consumer before changing them.

## Notes

- Rate limiting: 3–6s random delay between date variants; 5s between routes
- Filters (`maxStops`, `maxDurationHours`) are applied after Claude extraction, not at scrape time. When `maxStops` is `0`, `buildUrl()` also appends `nonstop` to the query as a *hint* to narrow what Google renders — the post-extraction filter remains authoritative.
- Google Flights defaults to "Best" ranking, which can leave the cheapest itinerary entirely unrendered. `sortByCheapest()` clicks the Cheapest tab; it is non-fatal and falls back to default sort if the tab is missing.
- Sticky/fixed elements are flattened to `position: static` before capture — otherwise Playwright's stitched full-page screenshot paints the Google header over a flight row.
- `scraper.js` takes an injected `log` function (defaults to `console.log`); `bot.js` passes its own route-prefixed logger that appends to `results.log`.
- `prices.json` uses route `name` as key — changing a route name resets its alert history
- The bot uses `claude-haiku-4-5-20251001` for cost efficiency on vision tasks
