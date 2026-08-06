---
name: route-management
description: Safely inspect, add, pause, resume, or reset Flightbot monitoring routes. Use when a user asks to view configured routes, change route settings, enable or disable a route, or clear a route's price history.
---

# Route Management

Inspect first and use only the maintained TypeScript CLI. Never edit `config.json`, `prices.json`, `.env`, or `results.log` directly.

## Inspect

Run:

```bash
pnpm exec tsx scripts/config-route.ts list
```

Read the route name and current state from its JSON output before proposing a mutation.

## Mutate

Translate the request into one exact CLI command. For an add, require origin, destination, and `YYYY-MM-DD` departure date; include only explicitly requested optional flags. Show the exact command and obtain explicit confirmation immediately before running it.

```bash
pnpm exec tsx scripts/config-route.ts add --from GRU --to JFK --depart 2026-09-10 --return 2026-09-20 --budget 4000 --stops 1
pnpm exec tsx scripts/config-route.ts pause "GRU → JFK"
pnpm exec tsx scripts/config-route.ts resume "GRU → JFK"
pnpm exec tsx scripts/config-route.ts reset "GRU → JFK"
```

Before a confirmed mutation, copy the affected local state to a temporary backup outside the repository. Run the command once, inspect its JSON result, then rerun `list` to verify the intended route state. Keep the backup until the user accepts the result; restore it only with explicit authorization.

Report CLI errors without guessing retries. `reset` deletes only the named route's saved price history. Production configuration is separate from a local checkout; do not deploy or copy state unless the user separately authorizes that work.
