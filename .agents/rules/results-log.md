---
paths:
  - bot.ts
  - scripts/lib/format-status.ts
globs:
  - bot.ts
  - scripts/lib/format-status.ts
---

# Parsed results log contract

Treat `results.log` as append-only. Its human-readable text and JSON alert records are parsed public contracts: do not rename, reorder, or reformat them unless every consumer changes together. Never colorize the log.
