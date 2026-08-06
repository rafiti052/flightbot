# Flight Price Monitor Bot

A Node.js bot that monitors Google Flights for price drops and sends Telegram alerts when a route hits or falls below your budget. Pages are scraped with Playwright and read by Claude vision.

---

## Prerequisites

- Node.js 18+ (uses native `fetch` and `process.loadEnvFile`)
- [pnpm](https://pnpm.io/)
- An Anthropic API key
- A Telegram bot (see [Connecting Telegram](#connecting-telegram))
- A VPS or always-on machine, for continuous monitoring

---

## Installation

```bash
pnpm install
pnpm run install-browsers
```

---

## Connecting Telegram

The bot pushes alerts to a Telegram chat through a bot account you create. Three steps: create the bot, let it message you, then find your chat ID.

### 1. Create the bot and get its token

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Pick a display name (anything) and a username (must end in `bot`, e.g. `my_flight_price_bot`).
4. BotFather replies with a token shaped like `123456789:AAExampleTokenReplaceMe`. Copy it into `.env` as `TELEGRAM_KEY`.

Treat this token like a password — anyone holding it can post as your bot. If it leaks, use `/revoke` in BotFather to issue a new one.

### 2. Start a conversation with your bot

**This step is required and easy to miss.** Telegram bots cannot message a user who has never contacted them. Open your new bot (BotFather links to it) and press **Start**, or send it any message. Skip this and sending fails with `403: bot was blocked by the user` or `400: chat not found`.

### 3. Find your chat ID

Message [@userinfobot](https://t.me/userinfobot); it replies with your numeric ID. Copy it into `.env` as `TELEGRAM_CHAT_ID`.

Alternatively, ask the API directly after step 2:

```bash
curl "https://api.telegram.org/bot<YOUR_TELEGRAM_KEY>/getUpdates"
```

Look for `"chat":{"id":123456789,...}`.

**Sending to a group instead of yourself:** add the bot to the group, send a message there, then run the `getUpdates` call above. Group IDs are negative (e.g. `-1001234567890`) — include the minus sign.

### 4. Verify it works

```bash
node scripts/test-scrape.js
```

This runs the full pipeline and sends a `[TEST]` message. If Telegram rejects it, the error and HTTP status are printed — `403`/`400` almost always means step 2 was skipped.

---

## Configuration

### Secrets — `.env`

Copy the example and fill it in:

```bash
cp .env.example .env
```

```
ANTHROPIC_KEY=your_anthropic_api_key_here
TELEGRAM_KEY=your_telegram_bot_api_key_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here

SSH_KEY_PATH=~/.ssh/your_key.pem
SSH_USER=ec2-user
SSH_HOST=ec2-xx-xx-xxx-xxx.compute-1.amazonaws.com
```

`.env` is gitignored and loaded automatically on startup. All credentials and account identifiers live here — `config.json` holds none. The bot refuses to start if `ANTHROPIC_KEY`, `TELEGRAM_KEY`, or `TELEGRAM_CHAT_ID` is missing.

The `SSH_*` vars are used only by the deploy scripts.

### Routes and schedule — `config.json`

```json
{
  "schedule": "0 8,11,14,17,20,23 * * *",
  "routes": [
    {
      "name": "GRU → FLN",
      "from": "GRU",
      "to": "FLN",
      "roundTrip": true,
      "departureDate": "2026-10-29",
      "returnDate": "2026-11-02",
      "flexDays": 0,
      "currency": "BRL",
      "maxStops": 0,
      "maxBudget": 1000,
      "maxDurationHours": 2,
      "active": true
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Label and `prices.json` key, e.g. `"GRU → FLN"` |
| `from` / `to` | string | yes | IATA codes |
| `roundTrip` | boolean | yes | `true` for round trip |
| `departureDate` | `YYYY-MM-DD` | yes | Must be in the future — past dates render an empty page and yield 0 results |
| `returnDate` | `YYYY-MM-DD` | round trips | |
| `flexDays` | integer | no | Expands departure ±N days; each variant is scraped separately (default `0`) |
| `currency` | string | no | e.g. `"BRL"`, `"USD"` (default `"USD"`) |
| `maxStops` | integer\|null | no | `null` = no filter. `0` also appends `nonstop` to the search query |
| `maxBudget` | number\|null | no | `null` = alert on any new low |
| `maxDurationHours` | number\|null | no | `null` = no filter |
| `active` | boolean | yes | `false` skips the route without deleting it |

Renaming a route resets its alert history, since `prices.json` is keyed by `name`.

### Schedule

Standard cron syntax. `"0 8,11,14,17,20,23 * * *"` runs at 8:00, 11:00, 14:00, 17:00, 20:00, and 23:00 daily.

---

## Running

```bash
node bot.js
```

The bot runs once immediately on startup, then follows the cron schedule.

### Docker

```bash
docker-compose up -d
```

`config.json`, `prices.json`, and `results.log` are bind-mounted, so they persist across rebuilds and can be edited on the host. Create all three before the first `up` — Docker creates a *directory* in place of a missing bind-mounted file.

---

## Scripts

Deterministic scripts in `scripts/` back the operational workflows in `.agents/workflows/` (exposed as slash commands via symlinks in `.claude/commands/` and `.cursor/commands/`) and are usable directly. Shell scripts read the `SSH_*` vars from `.env` and exit non-zero on failure.

Reusable agent skills follow the same layout: `.agents/skills/` is canonical, while supported
agent-specific skill directories contain relative symlinks to it.

| Script | Purpose |
|--------|---------|
| `scripts/test-scrape.js ["Route"]` | Full local smoke test; saves `test-screenshot.png` and sends a `[TEST]` alert |
| `scripts/config-route.js` | `list` / `add` / `pause` / `resume` / `reset` routes |
| `scripts/deploy.sh [--no-cache]` | Sync code to EC2, rebuild, restart, tail the log |
| `scripts/status.sh` | Container health, last run, issues, live `prices.json` |
| `scripts/logs.sh [--remote\|--docker] [N]` | Print logs from the chosen source |
| `scripts/remote-test.sh ["Route"]` | Run the smoke test inside the deployed container |

`deploy.sh` never syncs `config.json`, `prices.json`, or `results.log` — those are live server state.

---

## Alerts

| Type | Meaning |
|------|---------|
| `first` | First time the price is at or under budget |
| `lower` | Dropped below the last alerted price |
| `returned` | Back under budget after rising |

No alert fires while the price is above `maxBudget`. **A run that scrapes successfully and sends nothing is working correctly** — check `results.log` for `Best price:` to confirm it is finding flights.

### Resetting alert history

```bash
node scripts/config-route.js reset "GRU → FLN"   # one route
rm prices.json                                    # all routes
```

---

## Viewing logs

```bash
tail -f results.log          # local
scripts/logs.sh --remote     # server
scripts/logs.sh --docker     # container stdout, survives results.log loss
```

Logs mix human-readable lines with structured JSON records for each alert fired.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `403` / `400` from Telegram | You never pressed **Start** on your bot — see [step 2](#2-start-a-conversation-with-your-bot) |
| `Found 0 result(s)` every run | Departure dates are in the past, or filters are too tight |
| `Timed out waiting for flight cards` | Bot detection or a slow page; retry later |
| Truncated / unparseable Claude response | Raise `max_tokens` in `scraper.js` |
| Alerts never fire | `maxBudget` is below the real market price — check `Best price:` lines in the log |
