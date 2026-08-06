# harness-typescript-migration Validation

**Date**: 2026-08-06
**Spec**: `.specs/features/harness-typescript-migration/spec.md`
**Diff range**: `28535f3..834872b`
**Verifier**: independent sub-agent (author != verifier)

## Spec-Anchored Acceptance Criteria

| ID | Assertion | Evidence | Result |
| --- | --- | --- | --- |
| HTM-01 | Strict no-emit TypeScript checking succeeds over the repository. | `package.json:16` invokes `tsc --noEmit`; `tsconfig.json:10` enables `strict`; fresh `pnpm run typecheck` passed. | PASS |
| HTM-02 | Runtime entrypoints execute through `tsx`, with no build/emission script. | `package.json:11` starts `tsx bot.ts`; `Dockerfile:13` invokes `pnpm exec tsx bot.ts`; `package.json:10-21` has no build/emission script. | PASS |
| HTM-03 | Unit suite covers migrated branches without external services. | `tests/bot.test.ts:93-106`, `tests/scraper.test.ts:63-79`, and `tests/test-scrape.test.ts:1-204` use injected/local dependencies; fresh `pnpm test` passed 73/73. | PASS |
| HTM-04 | Route, status, and smoke contracts retain arguments/output/error behavior. | `tests/config-route.test.ts:1-190`, `tests/format-status.test.ts:50-150`, and `tests/test-scrape.test.ts:1-204` assert their CLI contracts; `scripts/lib/format-status.ts:179-195` retains wrapper I/O. | PASS |
| HTM-05 | Migrated TLC CLIs preserve fixture behavior and exit results. | `tests/tlc/validate-spec.test.ts:1-38`, `tests/tlc/validate-state.test.ts:1-41`, `tests/tlc/validate-tasks.test.ts:17-48`, `tests/tlc/check-commit.test.ts:1-25`, and `tests/tlc/lessons.test.ts:1-98`; both feature validators passed. | PASS |
| HTM-06 | Completed tracked tree has no Python executables or six obsolete application-JS path references. | Complete-tree `rg --files -g '*.py' -g '*.pyw'` found none; `rg` for `bot.js`, `scraper.js`, `ui.js`, `scripts/config-route.js`, `scripts/test-scrape.js`, and `scripts/lib/format-status.js` found none. | PASS |
| HTM-07 | PreToolUse denies destructive commands and asks before deploy/Docker cleanup. | `.claude/hooks/pre-tool-use.sh:20-29` classifies deny/ask; `tests/hooks.test.ts:38-66` asserts allow, ask, deny, and malformed JSON cases. | PASS |
| HTM-08 | PostToolUse non-fatally repairs edited TS/JS files only. | `.claude/hooks/post-tool-use.sh:8-27` filters extensions and tolerates formatter/linter failure; `tests/hooks.test.ts:68-94` asserts ignored and failure fixtures. | PASS |
| HTM-09 | Canonical scoped rules are exposed to all requested assistants. | `tests/rules.test.ts:1-44` resolves scraper, terminal-UI, and results-log rule links; `.agents/rules/scraper.md:1-10`, `.agents/rules/terminal-ui.md:1-10`, `.agents/rules/results-log.md:1-12` define the canonical contracts. | PASS |
| HTM-10 | Route/deploy skills and diagnostic scrape agent exist. | `tests/agent-harness.test.ts:1-109` asserts skill links and diagnostic boundaries; `.agents/skills/route-management/SKILL.md:1-33`, `.agents/skills/deploy-safety/SKILL.md:1-22`, `.claude/agents/scrape-debugger.md:1-19`. | PASS |
| HTM-11 | CI uses lockfile install and runs test/typecheck/lint/format, harness, and shell syntax gates. | `.github/workflows/ci.yml:22-35`; `tests/ci.test.ts:1-23`; fresh local composed gate passed. | PASS |
| HTM-12 | Harness gate enforces 70 percent. | `scripts/check-harness-score.ts:3,63-68`; `tests/check-harness-score.test.ts:1-40`; fresh `pnpm run harness:check` reported 97%. | PASS |
| HTM-13 | Migrated operational semantics remain represented in source and branch tests. | `scraper.ts:210-217,260-273` preserves model/prompt and filtering; `bot.ts:241-256` preserves alert branches; `tests/bot.test.ts:93-106` and `tests/scraper.test.ts:63-79` assert boundaries. | PASS |
| HTM-14 | Authorized live smoke mode is explicit `--json --no-send`; no live invocation was made. | `scripts/test-scrape.ts:5-8` documents the flags; `tests/test-scrape.test.ts:1-204` covers the smoke command without a live call. | PASS |
| HTM-15 | Independent verifier provides file-line evidence and kills at least five behavioral mutations. | This report plus the five isolated mutation results below; every targeted test failed on its intended assertion. | PASS |

**Status**: 15/15 assertions passed; no spec-precision gap blocked verification.

## Gates and Scope

| Check | Result |
| --- | --- |
| Frozen install | `pnpm install --frozen-lockfile` passed |
| Full quality gate | `pnpm run check` passed: 16 files, 73 tests passed; typecheck, ESLint, and Prettier passed |
| Harness | `pnpm run harness:check` passed: 97% (threshold 70%) |
| TLC validators | `validate_spec.ts` and `validate_tasks.ts` each reported 0 errors, 0 warnings |
| Shell syntax | `sh -n` passed for all 7 tracked `.sh` files |
| Hook fixtures | `tests/hooks.test.ts` passed: 6/6 |
| Lefthook | `pnpm exec lefthook validate` reported `All good` |
| Complete-tree scans | No Python executables and no references to six former application JavaScript paths |
| Diff integrity | `git diff --check 28535f3..834872b` passed |
| Docker | `docker build -t flightbot-verifier3:834872b .` passed; in-image `tsx` is `4.23.9` |

**Scope review**: inspected only `28535f3..834872b` implementation surface, the feature spec, repository instructions, tests, TLC validation reference, and source needed to establish evidence. No live scrape, Telegram, deploy, SSH, EC2, or Compose service operation was run.

## Discrimination Sensor

All mutants ran in separate detached worktrees at `834872b`, each with `pnpm install --offline --frozen-lockfile`. Before each test, `git diff --quiet` returned nonzero and the focused diff was inspected. Every scratch worktree was force-discarded; the verifier worktree was clean before writing this report.

| # | Worktree | Mutation | Targeted test and intended failed assertion | Killed |
| --- | --- | --- | --- | --- |
| 1 | `/tmp/flightbot-sensor3-1` | `bot.ts:251` changed `price > maxBudget` to `price >= maxBudget`. | `tests/bot.test.ts:102` expected boundary price to produce `first`, received `null`. | YES |
| 2 | `/tmp/flightbot-sensor3-2` | `scraper.ts:267` changed stop rejection `>` to `>=`. | `tests/scraper.test.ts:74` expected zero-stop flights retained, received `[]`. | YES |
| 3 | `/tmp/flightbot-sensor3-3` | `scripts/lib/format-status.ts:105` changed `value >= lastStart` to `value < lastStart`. | `tests/format-status.test.ts:96` expected a completed run with an in-run issue to be `DEGRADED`, received `HEALTHY`. | YES |
| 4 | `/tmp/flightbot-sensor3-4` | `validate_tasks.ts:188` changed final error-result expression to `return 0`. | `tests/tlc/validate-tasks.test.ts:31,42` expected exit `1` for errors/strict warning, received `0`. | YES |
| 5 | `/tmp/flightbot-sensor3-5` | `.claude/hooks/pre-tool-use.sh:21` changed recursive-removal decision from `deny` to `allow`. | `tests/hooks.test.ts:61` expected destructive-command `deny`, received `allow`. | YES |

**Sensor result**: 5/5 killed; 0 survived.

## Edge Cases

- [x] Missing Claude text block: `tests/scraper.test.ts:128-137` asserts the explicit extraction error.
- [x] Stale lock recovery/no overlap: `tests/bot.test.ts:156-205` covers lock outcomes.
- [x] Incomplete/malformed status data: `tests/format-status.test.ts:76-98,118-132` covers degradation and non-fatal malformed records.
- [x] Malformed hook JSON: `tests/hooks.test.ts:53-66` asserts deny.
- [x] Harness below threshold: `tests/check-harness-score.test.ts:1-40` asserts rejection.
- [x] Missing/ambiguous TLC target: `tests/tlc/validate-tasks.test.ts:39-48` asserts exit code 2.

## Code Quality

| Principle | Status |
| --- | --- |
| Minimum code and surgical feature scope | PASS |
| No unrelated behavioral upgrade observed in feature range | PASS |
| Existing patterns and documented repository guidelines followed | PASS (`AGENTS.md`) |
| Tests map to operational and harness acceptance outcomes | PASS |
| Spec-anchored asserted outcomes checked | PASS |

## Summary

**Overall**: PASS

**Spec-anchored check**: 15/15 passed
**Gate**: 73 passed, 0 failed, 0 skipped
**Harness score**: 97%
**Sensor**: 5/5 mutations killed
**Blockers/deviations**: none
