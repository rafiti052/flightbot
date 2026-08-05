Deploy the latest flightbot code to EC2 and restart the container.

Run:

```
/Users/rafael/Dev/flightbot/scripts/deploy.sh
```

Pass `--no-cache` if the user asks for a clean rebuild, or if a dependency in `package.json` / `pnpm-lock.yaml` changed:

```
/Users/rafael/Dev/flightbot/scripts/deploy.sh --no-cache
```

The script loads SSH details from `.env`, syncs code (never `config.json` / `prices.json` / `results.log`), rebuilds, restarts, and tails the log. It exits non-zero on failure.

Then report:

1. Which files synced.
2. Whether the container came back `Up`.
3. Whether the tailed log shows a clean start.

If the script exits non-zero, or the log contains `error`, `failed`, `Timed out`, or `Found 0 result`, print the relevant lines and **stop — do not declare success**.

To push a changed `config.json` (deliberately not synced by deploy), use `/reset-route` or copy it explicitly, then restart the container so the new config is picked up.
