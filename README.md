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

### Log rotation and retention

`results.log` is rotated automatically before each append when it grows beyond the max size. The old file is renamed to `results-YYYYMMDD-HHmmss.log`, and only the newest rotated archives are kept.

- `FLIGHTBOT_LOG_MAX_BYTES` (default: `20971520`, i.e. 20 MB)
- `FLIGHTBOT_LOG_RETAIN_FILES` (default: `7`)

### Next.js dashboard (primary UI)

```bash
npm run web:dev
```

Opens the dashboard on port **3001** (see `apps/web`). It reads the same data directory and polls `.flightbot/last-run.json` after each bot run. For config saves proxied through the web app, set **`FLIGHTBOT_BOT_URL`** to the bot admin URL (e.g. `http://localhost:3000`).

#### UI + bot architecture

- `bot.js` is the runtime composition entrypoint (startup wiring, scheduling, Express route registration).
- `packages/runtime/core.js` contains shared runtime domain helpers (dates, URL/message formatting, alert evaluation, status read-model shaping).
- `packages/runtime/worker.js` contains worker-owned foundations (price store + results log adapter).
- `packages/runtime/orchestration.js` contains worker run orchestration (startup run lock, stale lock handling, cron registration/re-registration).
- `packages/runtime/api.js` contains API-owned foundations (admin auth, config merge policy, config write rate limiting).
- `apps/web` is the authenticated configuration dashboard (structured schedule UI + advanced JSON editor).
- Legacy embedded HTML UI has been removed from the bot runtime to keep API responsibilities focused.
- `results.log` is owned by the worker logging pipeline (rotation/retention controlled via `FLIGHTBOT_LOG_MAX_BYTES` and `FLIGHTBOT_LOG_RETAIN_FILES`).
- Optional helper: set `FLIGHTBOT_WEB_URL` so bot root (`/`) can point to your deployed dashboard URL.

#### Vercel environment notes

For the first production rollout, it is fine to configure environment variables only for the **Production** environment in Vercel. Preview environments are optional and can be added later per branch if needed.

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

## CI test gates (web)

GitHub Actions runs the web app test suite with unit tests gating e2e execution:

```bash
npm run test:unit -w @flightbot/web
npm run e2e -w @flightbot/web
```

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
