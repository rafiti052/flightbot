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
pnpm install
pnpm run install-browsers
```

---

## Configuration

The bot prefers **`config.yml`** in **`FLIGHTBOT_DATA_DIR`** (shared with the optional Next.js UI). On first startup, if only **`config.json`** exists there, it is migrated once to `config.yml`.

Set **`FLIGHTBOT_DATA_DIR`** to the directory that contains the bot's runtime state. During this refactor, the local-dev default remains the repo root when `FLIGHTBOT_DATA_DIR` is unset, but explicit configuration is recommended for any persistent or shared environment.

### Runtime state in `FLIGHTBOT_DATA_DIR`

The bot reads and writes its runtime state from `FLIGHTBOT_DATA_DIR`:

- `config.yml` - main config (preferred). If only legacy `config.json` exists there, startup migrates it once.
- `prices.json` - persisted alert history per route.
- `results.log` - append-only log for human-readable lines and JSON alert records.
- `.flightbot/last-run.json` - last-run status snapshot used by the dashboard.

Current local-dev decision during this refactor: if `FLIGHTBOT_DATA_DIR` is not set, the bot falls back to the repo root as a temporary data directory. That keeps existing local workflows working while runtime ownership moves fully under `apps/bot`.

### Log rotation and retention

`results.log` is rotated automatically before each append when it grows beyond the max size. The old file is renamed to `results-YYYYMMDD-HHmmss.log`, and only the newest rotated archives are kept.

- `FLIGHTBOT_LOG_MAX_BYTES` (default: `20971520`, i.e. 20 MB)
- `FLIGHTBOT_LOG_RETAIN_FILES` (default: `7`)

### Next.js dashboard (primary UI)

```bash
pnpm run dashboard:dev
```

Opens the dashboard on port **3001** (implemented in `apps/web`). It reads the same data directory and polls `.flightbot/last-run.json` after each bot run. For config saves proxied through the dashboard, set **`FLIGHTBOT_BOT_URL`** to the bot admin URL (e.g. `http://localhost:3000`).

#### UI + bot architecture

- `apps/bot/bot.js` is the runtime composition entrypoint (startup wiring, scheduling, Express route registration).
- `apps/bot/runtime/core.js` contains shared runtime domain helpers (dates, URL/message formatting, alert evaluation, status read-model shaping).
- `apps/bot/runtime/worker.js` contains worker-owned foundations (price store + results log adapter).
- `apps/bot/runtime/orchestration.js` contains worker run orchestration (startup run lock, stale lock handling, cron registration/re-registration).
- `apps/bot/runtime/api.js` contains API-owned foundations (admin auth, config merge policy, config write rate limiting).
- `apps/web` is the authenticated configuration dashboard (structured schedule UI + advanced JSON editor).
- Legacy embedded HTML UI has been removed from the bot runtime to keep API responsibilities focused.
- Runtime logs and state live in `FLIGHTBOT_DATA_DIR`; `results.log` is owned by the worker logging pipeline (rotation/retention controlled via `FLIGHTBOT_LOG_MAX_BYTES` and `FLIGHTBOT_LOG_RETAIN_FILES`).
- Optional helper: set `FLIGHTBOT_WEB_URL` so bot root (`/`) can point to your deployed dashboard URL.

#### Vercel environment notes

For the first production rollout, it is fine to configure environment variables only for the **Production** environment in Vercel. Preview environments are optional and can be added later per branch if needed.

The Vercel project name is `flightbot`, and the deployed dashboard source lives under `apps/web`.

- Keep the Vercel project **Root Directory** set to `apps/web` in project settings.
- Manual deploy shortcuts from repo root:
  - `pnpm run vercel:preview`
  - `pnpm run vercel:prod`
- The deploy scripts force `--cwd apps/web` so CLI deploys stay aligned with the dashboard source.

### Docker

`docker compose up` starts the **flightbot** bot service (port 3000). The bot reads runtime state from `FLIGHTBOT_DATA_DIR` inside the container, with the host directory supplied by `FLIGHTBOT_HOST_DATA_DIR`.

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
FLIGHTBOT_DATA_DIR="$PWD" node apps/bot/bot.js
```

The bot runs once immediately on startup, then follows the cron schedule.

---

## CI test gates (dashboard)

GitHub Actions runs the dashboard test suite with unit tests gating e2e execution:

```bash
pnpm --filter @flightbot/web test:unit
pnpm --filter @flightbot/web e2e
```

---

## Running with PM2 (persistent, auto-restart)

```bash
npm install -g pm2
FLIGHTBOT_DATA_DIR=/opt/flightbot/data pm2 start apps/bot/bot.js --name flight-bot --update-env
pm2 save && pm2 startup
```

---

## Resetting best prices

To force the bot to re-alert even if prices haven't improved (e.g. after changing routes):

```bash
rm "$FLIGHTBOT_DATA_DIR/prices.json"
```

---

## Viewing logs

```bash
tail -f "$FLIGHTBOT_DATA_DIR/results.log"
```

Logs include both human-readable lines and structured JSON records for each alert fired.
