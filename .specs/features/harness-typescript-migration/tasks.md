# Flightbot TypeScript and Agent-Harness Migration Tasks

## Execution Protocol (MANDATORY — do not skip)

Implement with the `tlc-spec-driven` skill Execute flow. Every task ends with its focused test, task status update, conventional-commit validation, and one atomic commit. Use at most three `gpt-5.6-terra` medium workers in isolated worktrees; workers cannot spawn subagents or widen owned files. The root integrates commits in task order and retains only task IDs, commit hashes, test counts, and deviations.

**Design**: `.specs/features/harness-typescript-migration/design.md`
**Status**: In Progress

## Test Coverage Matrix

| Layer | Cases required | Isolation |
| --- | --- | --- |
| Alert/date/run lock | Every alert type/silence boundary, flex ranges, state updates, fresh/stale locks, thrown dependencies | temp files, fake clock, injected scraper/sender |
| Scraper pure logic | round/one-way/missing dates/nonstop URL, duration forms, all filters, text/non-text response, timeouts | fake browser/Anthropic client |
| Terminal UI | ANSI environment, Unicode width, truncation, tables, money/duration/status, non-TTY progress | controlled env and fake streams |
| Route/status CLIs | every command/flag/error, duplicate/malformed data, state mutation, health verdicts and parsed log shapes | temp files and captured streams |
| Smoke runner | parser errors, stage/result JSON, empty-after-filter distinction, no-send, external failures | injected scraper/sender/filesystem |
| TLC scripts | Python parity for exits, streams, resolution, validation, Unicode normalization, and state/render mutations | fixture corpus; Python retained until parity |
| Hooks | allow/ask/deny, malformed input, extension filter, nonfatal repair failure | stdin subprocess fixtures |
| Integration | package gates, shell syntax, Docker runtime, inactive boot, obsolete-path searches, score threshold | no external network APIs at runtime |

## Gate Check Commands

- **Focused TypeScript**: `pnpm exec vitest run <owned test files> && pnpm run typecheck`
- **Wave**: `pnpm run test && pnpm run typecheck && pnpm run lint && pnpm run format:check`
- **Full**: `pnpm run check && pnpm run harness:check` plus TLC validators and `bash -n` checks.
- **Task commit**: `pnpm exec tsx .agents/skills/tlc-spec-driven/scripts/check_commit.ts --message '<message>'` after T10; Python equivalent before T10.

## Execution Plan

Phases run sequentially. Tasks explicitly grouped under the same wave may run in parallel only in distinct worktrees.

```text
Phase 0: T00 -> T01 -> T02
Phase 1: T03 | T04 | (T05,T06,T07,T08,T09,T10)
Phase 2: T11 | (T12,T13) | (T14,T15)
Phase 3: (T16,T17,T18,T19) | (T20,T21) | (T22,T23,T24)
Phase 4: T25 | T26
Phase 5: T27
T16 -> T19
T17 -> T19
T18 -> T19
T18 -> T23
```

## Task Breakdown

### Phase 0: Serial preflight

### T00: Vendor installed TLC skill

**Status**: Complete
**What**: Checkpoint the installed canonical skill, documentation, and agent links while excluding downloaded hash metadata.
**Where**: `.agents/skills/tlc-spec-driven/` plus existing docs/links
**Depends on**: None
**Requirement**: HTM-10
**Owned files**: `.gitignore`, `AGENTS.md`, `README.md`, `.agents/skills/tlc-spec-driven/**`, `.claude/skills/tlc-spec-driven`, `.cursor/skills/tlc-spec-driven`
**Done when**: Metadata is absent/ignored, links resolve, staged paths are exact, and commit validation passes.
**Tests**: filesystem contract
**Gate**: `git diff --check` and Python `check_commit.py`
**Commit**: `chore(agent): vendor tlc spec driven skill`

### T01: Materialize migration specification

**Status**: Complete
**What**: Create STATE, specification, context, design, tasks, and the verified 41/108 harness baseline.
**Where**: `.specs/`
**Depends on**: T00
**Requirement**: HTM-01, HTM-15
**Owned files**: `.specs/**`
**Done when**: Every requirement is EARS-shaped and traceable, execution ownership is explicit, and current Python validators pass.
**Tests**: specification validation
**Gate**: Python `validate_spec.py` and `validate_tasks.py`
**Commit**: `docs(spec): define harness TypeScript migration`

### T02: Establish TypeScript quality toolchain

**Status**: Complete
**What**: Add locked dependencies, package scripts, strict compiler config, shared types, Vitest, ESLint, and Prettier foundations without switching runtime entrypoints.
**Where**: package and root tooling files
**Depends on**: T01
**Requirement**: HTM-01, HTM-02, HTM-03, HTM-11, HTM-12
**Owned files**: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `types.ts`, `vitest.config.ts`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`
**Done when**: Frozen install, foundation typecheck, lint, and format checks pass; Node engine is `>=20.19.0`.
**Tests**: tooling smoke
**Gate**: frozen install, typecheck, lint, format check
**Commit**: `build(tooling): add TypeScript quality harness`

### Phase 1: Independent foundations

### T03: Migrate terminal UI

**Status**: Complete
**What**: Rename and strictly type terminal helpers without changing visual or non-TTY contracts.
**Where**: `ui.ts`
**Depends on**: T02
**Requirement**: HTM-01, HTM-03, HTM-13
**Owned files**: `ui.js`, `ui.ts`, `tests/ui.test.ts`, owned T03 block
**Done when**: ANSI/color decisions, Unicode width, truncation, tables, money, duration, status, and non-TTY progress are covered and compatible.
**Tests**: unit
**Gate**: focused TypeScript
**Commit**: `refactor(ui): migrate terminal helpers to TypeScript`

### T04: Migrate scraper pipeline

**Status**: Complete
**What**: Rename/type the scraper, preserve five exports and external contracts, and explicitly reject responses without a text block.
**Where**: `scraper.ts`
**Depends on**: T02
**Requirement**: HTM-01, HTM-03, HTM-13
**Owned files**: `scraper.js`, `scraper.ts`, `tests/scraper.test.ts`, owned T04 block
**Done when**: URL, duration, filtering, Claude response, selector, prompt, delay, and timeout behavior is covered without external calls.
**Tests**: unit with injected browser/client
**Gate**: focused TypeScript
**Commit**: `refactor(scraper): migrate scrape pipeline to TypeScript`

### T05: Migrate specification validator

**Status**: Complete
**What**: Port `validate_spec.py` to import-safe strict TypeScript and delete Python only after parity fixtures pass.
**Where**: `.agents/skills/tlc-spec-driven/scripts/validate_spec.ts`
**Depends on**: T02
**Requirement**: HTM-05, HTM-06
**Owned files**: Python/TypeScript validator pair, `tests/tlc/validate-spec.test.ts`, owned T05 block
**Done when**: valid, invalid, warning, strict, missing, ambiguous, file, directory, name, and autodetect modes match.
**Tests**: Python/TypeScript parity
**Gate**: focused TLC test and typecheck
**Commit**: `refactor(tlc): migrate specification validator`

### T06: Migrate task validator

**Status**: Complete
**What**: Port task validation with identical fields, dependencies, diagrams, warnings, and resolution semantics.
**Where**: `.agents/skills/tlc-spec-driven/scripts/validate_tasks.ts`
**Depends on**: T02
**Requirement**: HTM-05, HTM-06
**Owned files**: Python/TypeScript validator pair, `tests/tlc/validate-tasks.test.ts`, owned T06 block
**Done when**: required fields, forward dependencies, diagram parity, warnings, strict mode, and autodetection match Python.
**Tests**: Python/TypeScript parity
**Gate**: focused TLC test and typecheck
**Commit**: `refactor(tlc): migrate task validator`

### T07: Migrate state validator

**Status**: Complete
**What**: Port state/validation report checks with identical feature resolution and evidence rules.
**Where**: `.agents/skills/tlc-spec-driven/scripts/validate_state.ts`
**Depends on**: T02
**Requirement**: HTM-05, HTM-06, HTM-15
**Owned files**: Python/TypeScript validator pair, `tests/tlc/validate-state.test.ts`, owned T07 block
**Done when**: missing, unfilled, FAIL, evidence-free, PASS, and multi-feature cases preserve exit/stream behavior.
**Tests**: Python/TypeScript parity
**Gate**: focused TLC test and typecheck
**Commit**: `refactor(tlc): migrate state validator`

### T08: Migrate commit checker

**Status**: Complete
**What**: Port conventional-commit validation and all input modes.
**Where**: `.agents/skills/tlc-spec-driven/scripts/check_commit.ts`
**Depends on**: T02
**Requirement**: HTM-05, HTM-06
**Owned files**: Python/TypeScript checker pair, `tests/tlc/check-commit.test.ts`, owned T08 block
**Done when**: types, scope, breaking footer, capitalization, punctuation, comments, stdin/file/message, errors, and 72-character warnings match.
**Tests**: Python/TypeScript parity
**Gate**: focused TLC test and typecheck
**Commit**: `refactor(tlc): migrate commit checker`

### T09: Migrate lessons store

**Status**: Complete
**What**: Port lesson normalization, validation, lifecycle mutation, and rendering while preserving Unicode behavior.
**Where**: `.agents/skills/tlc-spec-driven/scripts/lessons.ts`
**Depends on**: T02
**Requirement**: HTM-05, HTM-06
**Owned files**: Python/TypeScript lessons pair, `tests/tlc/lessons.test.ts`, owned T09 block
**Done when**: Portuguese/Japanese normalization, promotion, duplicates, pruning, penalization, quarantine, rendering, and validation errors match.
**Tests**: Python/TypeScript parity with temp store
**Gate**: focused TLC test and typecheck
**Commit**: `refactor(tlc): migrate lessons store`

### T10: Switch TLC documentation and invocations

**Status**: Complete
**What**: Replace every Python TLC instruction and invocation with `pnpm exec tsx`, document Node/tsx prerequisites, and use Lefthook guidance.
**Where**: `.agents/skills/tlc-spec-driven/`
**Depends on**: T02
**Requirement**: HTM-05, HTM-06
**Owned files**: skill docs/references, all five `.py` removals, owned T10 block
**Done when**: All TypeScript validators self-validate artifacts and no `.py` or Python invocation remains.
**Tests**: invocation and obsolete-reference search
**Gate**: TypeScript validators, `rg` absence checks, typecheck
**Commit**: `docs(tlc): run validation scripts with tsx`

### Phase 2: Application and operational CLIs

### T11: Migrate bot runtime

**Status**: Complete
**What**: Rename/type bot orchestration, add an import-safe direct-entry guard, and expose injectable test boundaries.
**Where**: `bot.ts`
**Depends on**: T03, T04
**Requirement**: HTM-01, HTM-03, HTM-13
**Owned files**: `bot.js`, `bot.ts`, `tests/bot.test.ts`, owned T11 block
**Done when**: All alert, flex-date, lock, error, state-transition, schedule, rate-limit, and stable-log branches pass without external calls.
**Tests**: unit/integration with temp state
**Gate**: focused TypeScript
**Commit**: `refactor(bot): migrate runtime to TypeScript`

### T12: Migrate route manager

**Status**: Complete
**What**: Rename/type route management and expose an argv/path/output function while retaining CLI behavior.
**Where**: `scripts/config-route.ts`
**Depends on**: T02
**Requirement**: HTM-01, HTM-04, HTM-13
**Owned files**: JS/TS route CLI, `tests/config-route.test.ts`, owned T12 block
**Done when**: list/add/update/remove/toggle plus duplicate, flag, and malformed-data paths match using temp config files.
**Tests**: CLI contract
**Gate**: focused TypeScript
**Commit**: `refactor(routes): migrate route manager to TypeScript`

### T13: Migrate status formatter

**Status**: Complete
**What**: Rename/type status formatting and separate pure formatting from stdin/config I/O.
**Where**: `scripts/lib/format-status.ts`
**Depends on**: T02
**Requirement**: HTM-01, HTM-04, HTM-13
**Owned files**: JS/TS formatter, `tests/format-status.test.ts`, owned T13 block
**Done when**: HEALTHY, DEGRADED, DOWN, incomplete, issue, budget, inactive, and malformed-price fixtures preserve public text.
**Tests**: formatter and CLI fixtures
**Gate**: focused TypeScript
**Commit**: `refactor(status): migrate status formatter to TypeScript`

### T14: Migrate scrape smoke CLI

**Status**: Complete
**What**: Rename/type smoke testing, export parsing/runner functions, and inject scraper/sender/filesystem boundaries.
**Where**: `scripts/test-scrape.ts`
**Depends on**: T04
**Requirement**: HTM-01, HTM-03, HTM-04, HTM-14
**Owned files**: JS/TS smoke CLI, `tests/test-scrape.test.ts`, owned T14 block
**Done when**: argument errors, stage/result JSON, human output, filter-empty distinction, no-send, and mocked failures are covered.
**Tests**: unit/CLI with external mocks
**Gate**: focused TypeScript
**Commit**: `refactor(smoke): migrate scrape smoke test to TypeScript`

### T15: Add deterministic harness threshold

**Status**: Complete
**What**: Run the pinned scanner, parse JSON, and exit non-zero below 70 percent with injectable process execution for tests.
**Where**: `scripts/check-harness-score.ts`
**Depends on**: T02
**Requirement**: HTM-12
**Owned files**: harness CLI/test and package harness scripts, owned T15 block
**Done when**: malformed scanner output, scanner failure, 69.99, 70, and above-threshold cases are deterministic.
**Tests**: unit/CLI
**Gate**: focused TypeScript plus real harness run
**Commit**: `build(harness): add deterministic score gate`

### Phase 3: Runtime integration and agent harness

### T16: Switch runtime package entrypoint

**Status**: Complete
**What**: Point package `main` and `start` at `bot.ts` through `tsx` without emission.
**Where**: `package.json`
**Depends on**: T11
**Requirement**: HTM-02, HTM-13
**Owned files**: package runtime fields/scripts, owned T16 block
**Done when**: inactive-route boot with fake keys reaches startup/run-complete logs without external calls.
**Tests**: runtime boot
**Gate**: package start integration
**Commit**: `build(runtime): run flightbot with tsx`

### T17: Switch Docker runtime

**Status**: Complete
**What**: Copy required TypeScript sources/config and execute through `tsx` with production-only dependencies and no build stage.
**Where**: `Dockerfile`
**Depends on**: T11
**Requirement**: HTM-02, HTM-11, HTM-13
**Owned files**: Docker files and owned T17 block
**Done when**: `flightbot-ts-verify` builds and reports `tsx --version` inside the image.
**Tests**: Docker build/runtime smoke
**Gate**: local image verification
**Commit**: `build(docker): run TypeScript entrypoint`

### T18: Switch operational shell invocations

**Status**: Complete
**What**: Update deploy sync lists, status, and remote-test commands to TypeScript without executing deployment.
**Where**: `scripts/**/*.sh`
**Depends on**: T11, T12, T13, T14
**Requirement**: HTM-04, HTM-06, HTM-13, HTM-14
**Owned files**: operational shell scripts/workflow calls and owned T18 block
**Done when**: every shell file passes `bash -n` and no obsolete application path remains in operational code.
**Tests**: shell syntax and command-string contract
**Gate**: `bash -n` plus searches
**Commit**: `refactor(ops): point scripts at TypeScript`

### T19: Document TypeScript operations

**Status**: Pending
**What**: Update canonical workflows, README, AGENTS, and troubleshooting references to TypeScript and Node `>=20.19`.
**Where**: repository docs and `.agents/workflows/`
**Depends on**: T16, T17, T18
**Requirement**: HTM-02, HTM-04, HTM-06, HTM-13, HTM-14
**Owned files**: docs/workflows and owned T19 block
**Done when**: documented commands resolve to real files/scripts and contain no former application paths.
**Tests**: documentation command/reference search
**Gate**: format and obsolete-reference checks
**Commit**: `docs(runtime): document TypeScript operations`

### T20: Add Claude safety hooks

**Status**: Pending
**What**: Configure executable PreToolUse/PostToolUse hooks with current structured permission decisions and best-effort format repair.
**Where**: `.claude/settings.json`, `.claude/hooks/`
**Depends on**: T02
**Requirement**: HTM-07, HTM-08
**Owned files**: Claude settings/hooks, hook tests, owned T20 block
**Done when**: benign allow, deploy/Docker ask, destructive deny, malformed input, extension filtering, and nonfatal failures pass subprocess tests.
**Tests**: subprocess contract
**Gate**: focused hook test and `bash -n`
**Commit**: `feat(hooks): guard risky agent commands`

### T21: Add path-scoped rules

**Status**: Pending
**What**: Define canonical scraper, UI, and parsed-log rules with Claude `paths` and Cursor `globs`, then link all three assistant surfaces.
**Where**: `.agents/rules/` and agent-specific rule directories
**Depends on**: T02
**Requirement**: HTM-09
**Owned files**: rule docs/links and owned T21 block
**Done when**: all metadata scopes match real files and every relative link resolves.
**Tests**: metadata/link contract
**Gate**: filesystem checks and format
**Commit**: `docs(rules): add scoped flightbot guidance`

### T22: Add route-management skill

**Status**: Complete
**What**: Add a focused canonical skill for safe route inspection/mutation through the maintained CLI and link supported assistants.
**Where**: `.agents/skills/route-management/`
**Depends on**: T12
**Requirement**: HTM-10
**Owned files**: route skill/links and owned T22 block
**Done when**: instructions use real TypeScript commands, preserve backups/validation, and links resolve.
**Tests**: skill structure/reference contract
**Gate**: filesystem and obsolete-reference checks
**Commit**: `feat(skill): add route management guidance`

### T23: Add deploy-safety skill

**Status**: Complete
**What**: Add canonical read-first deploy guidance with explicit human gates and no implicit deployment.
**Where**: `.agents/skills/deploy-safety/`
**Depends on**: T18
**Requirement**: HTM-10
**Owned files**: deploy skill/links and owned T23 block
**Done when**: instructions distinguish checks from mutations and require confirmation before deploy/stop/removal.
**Tests**: skill structure and forbidden-command contract
**Gate**: filesystem/reference checks
**Commit**: `feat(skill): add deploy safety guidance`

### T24: Add scrape-debugger agent

**Status**: Complete
**What**: Define a diagnostic-only custom agent with no edit/write tools and mandatory `--no-send` path.
**Where**: `.claude/agents/scrape-debugger.md`
**Depends on**: T14
**Requirement**: HTM-10, HTM-14
**Owned files**: diagnostic agent definition and owned T24 block
**Done when**: frontmatter excludes write/edit tools and instructions forbid send/deploy/config/state mutation.
**Tests**: agent policy contract
**Gate**: metadata/content assertions
**Commit**: `feat(agent): add scrape debugger`

### Phase 4: Merge gates

### T25: Add deterministic CI

**Status**: Pending
**What**: Add least-privilege GitHub Actions on Node 22/pnpm 11.5.1 with frozen install and every repository gate.
**Where**: `.github/workflows/ci.yml`
**Depends on**: T15, T18, T20
**Requirement**: HTM-11, HTM-12
**Owned files**: CI workflow and owned T25 block
**Done when**: workflow runs `pnpm run check`, `harness:check`, and shell syntax without secrets or external scrape.
**Tests**: workflow static contract and local equivalent
**Gate**: full local gate
**Commit**: `ci: add deterministic quality pipeline`

### T26: Add local Git gates

**Status**: Pending
**What**: Configure sequential staged ESLint-fix then Prettier and a commit-msg TLC checker through Lefthook.
**Where**: `lefthook.yml`
**Depends on**: T08, T10
**Requirement**: HTM-05, HTM-08, HTM-11
**Owned files**: Lefthook config/package integration and owned T26 block
**Done when**: Lefthook validates/installs through pnpm postinstall and fixture commits demonstrate ordering and commit rejection.
**Tests**: configuration and hook smoke
**Gate**: Lefthook validate plus full local gate
**Commit**: `build(git): add local commit gates`

### Phase 5: Independent validation

### T27: Verify requirements and discrimination sensor

**Status**: Pending
**What**: Run all deterministic gates, then dispatch a fresh Terra-medium verifier to write an evidence-backed PASS/FAIL report and kill at least five isolated behavior mutations.
**Where**: `.specs/features/harness-typescript-migration/validation.md`
**Depends on**: T25, T26
**Requirement**: HTM-01, HTM-02, HTM-03, HTM-04, HTM-05, HTM-06, HTM-07, HTM-08, HTM-09, HTM-10, HTM-11, HTM-12, HTM-13, HTM-14, HTM-15
**Owned files**: validation report only; mutation worktree must be discarded
**Done when**: Every requirement has `file:line` assertion evidence, at least five mutations are killed, `validate_state.ts` passes, and porcelain contains only expected committed work.
**Tests**: full gate plus independent mutations
**Gate**: full validation checklist
**Commit**: `test(validation): verify TypeScript harness migration`

## Phase Execution Map

```text
T00 -> T01 -> T02
T02 -> Wave 1 -> Wave 2 -> Wave 3 -> Wave 4 -> T27
```

Parallel work is limited to the explicit wave lanes above. A worker executes its assigned task block serially, reports compact evidence, and stops on ownership conflicts or unexpected files.
