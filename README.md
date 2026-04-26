# Flight Price Monitor Bot

A Node.js bot that monitors Google Flights for price drops and sends Telegram alerts when a new best price is found for a configured route.

---

## Prerequisites

- Node.js 18+ (uses native `fetch`)
- A VPS or always-on machine (for continuous monitoring)
- A Telegram bot token and chat ID

---

## Installation

```bash
npm install
npm run install-browsers
```

---

## Configuration

The bot prefers **`config.yml`** at the project root (shared with the optional Next.js UI). On first startup, if only **`config.json`** exists, it is migrated once to `config.yml`.

Set **`FLIGHTBOT_DATA_DIR`** to the directory that contains `config.yml`, `prices.json`, and `results.log` (defaults to the directory that contains `bot.js`).

### Next.js dashboard (optional)

```bash
npm run web:dev
```

Opens the read-only dashboard on port **3001** (see `apps/web`). It reads the same data directory and polls `.flightbot/last-run.json` after each bot run. For config saves proxied through the web app, set **`FLIGHTBOT_BOT_URL`** to the bot admin URL (e.g. `http://localhost:3000`).

### Docker

`docker compose up` starts **flightbot** (port 3000) and **flightbot-web** (port 3001) with `./` mounted as the shared data directory.

---

## Legacy JSON shape (still valid after migration)

Edit `config.json` before first run if you have not migrated yet; after migration, edit `config.yml` instead.

```json
{
  "telegram": {
    "token": "YOUR_BOT_TOKEN_HERE",
    "chatId": "YOUR_CHAT_ID_HERE"
  },
  "schedule": "0 7,13,20 * * *",
  "routes": [...]
}
```

### Getting your Telegram credentials

1. **Bot token**: Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → follow the prompts → copy the token
2. **Chat ID**: Message [@userinfobot](https://t.me/userinfobot) on Telegram → it will reply with your chat ID

### Route fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable label, e.g. `"GRU → LIS"` |
| `from` | string | yes | Origin IATA code, e.g. `"GRU"` |
| `to` | string | yes | Destination IATA code, e.g. `"LIS"` |
| `roundTrip` | boolean | yes | `true` for round trip, `false` for one-way |
| `active` | boolean | yes | `false` to skip this route without removing it |
| `tripDuration` | integer | no | Days at destination (round trips only) |
| `daysAheadMin` | integer | no | How many days from today to set departure (default: 7) |
| `currency` | string | no | Currency code, e.g. `"BRL"`, `"USD"` |
| `maxStops` | integer\|null | no | Max number of stops; `null` = no filter |
| `maxBudget` | number\|null | no | Max price; `null` = no filter |
| `maxDurationHours` | number\|null | no | Max total flight duration in hours; `null` = no filter |

### Schedule

Uses standard cron syntax. Default `"0 7,13,20 * * *"` runs at 7:00, 13:00, and 20:00 every day.

---

## Running

```bash
node bot.js
```

The bot runs once immediately on startup, then follows the cron schedule.

---

## Running with PM2 (persistent, auto-restart)

```bash
npm install -g pm2
pm2 start bot.js --name flight-bot
pm2 save && pm2 startup
```

---

## Resetting best prices

To force the bot to re-alert even if prices haven't improved (e.g. after changing routes):

```bash
rm prices.json
```

---

## Viewing logs

```bash
tail -f results.log
```

Logs include both human-readable lines and structured JSON records for each alert fired.
