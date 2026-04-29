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

The bot uses **`config.yml`** in **`FLIGHTBOT_DATA_DIR`** (shared with the optional Next.js UI).

Set **`FLIGHTBOT_DATA_DIR`** to the directory that contains the bot's runtime state. For local development, `scripts/start-bot.sh` still falls back to the repo root when `FLIGHTBOT_DATA_DIR` is unset. For Docker, AWS, PM2, or any shared environment, set it explicitly and keep runtime state outside the repo checkout.

### Runtime state in `FLIGHTBOT_DATA_DIR`

The bot reads and writes its runtime state from `FLIGHTBOT_DATA_DIR`:

- `config.yml` - main config.
- `prices.json` - persisted alert history per route.
- `results.log` - append-only log for human-readable lines and JSON alert records.
- `.flightbot/last-run.json` - last-run status snapshot used by the dashboard.

Current local-dev fallback: `scripts/start-bot.sh` uses the repo root only when `FLIGHTBOT_DATA_DIR` is unset. Treat that as a temporary convenience for local work, not a deploy default.

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

`docker compose up` starts the **flightbot** bot service (port 3000).

- Set `FLIGHTBOT_HOST_DATA_DIR` to an absolute host path outside the repo checkout.
- Docker mounts that host directory into the container and sets `FLIGHTBOT_DATA_DIR=/data`.
- Keep `config.yml`, `prices.json`, `results.log`, and `.flightbot/` in that host-owned data directory.

---

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
cp .env.example bot.env.local
# edit bot.env.local
./scripts/start-bot.sh
```

`scripts/start-bot.sh` loads `bot.env.local`, normalizes `FLIGHTBOT_DATA_DIR`, creates missing runtime files, and starts `node apps/bot/bot.js`. If `FLIGHTBOT_DATA_DIR` is unset there, local dev temporarily falls back to the repo root.

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

Use a dedicated data directory outside the repo checkout, with `config.yml` already present there.

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
