---
description: Preserve Flightbot terminal formatting and non-TTY output contracts.
trigger: ui.ts
paths:
  - ui.ts
globs:
  - ui.ts
---

# Terminal UI contract

Use `ui.ts` semantic helpers for colors, glyphs, widths, tables, money, and durations. Keep formatted progress TTY-only. Non-TTY output stays plain and timestamped; honor `NO_COLOR` and `FORCE_COLOR` without embedding ANSI codes in callers.
