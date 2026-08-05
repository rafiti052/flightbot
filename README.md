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

### Secrets

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

```
ANTHROPIC_KEY=your_anthropic_api_key_here
TELEGRAM_KEY=your_telegram_bot_api_key_here
```

`.env` is gitignored and loaded automatically on startup — never put real keys in `config.json`.

### `config.json`

Edit `config.json` for everything else:

```json
{
  "telegram": {
    "chatId": "YOUR_CHAT_ID_HERE"
  },
  "schedule": "0 7,13,20 * * *",
  "routes": [...]
}
```

### Getting your Telegram credentials

1. **Bot token**: Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → follow the prompts → copy the token into `.env` as `TELEGRAM_KEY`
2. **Chat ID**: Message [@userinfobot](https://t.me/userinfobot) on Telegram → it will reply with your chat ID → put it in `config.json` as `telegram.chatId`

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
