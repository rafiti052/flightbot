# Flightbot TypeScript and Agent-Harness Migration Specification

## Problem Statement

Flightbot is an operational Node application whose JavaScript runtime and Python-only TLC gates have no static type boundary or deterministic unit-test suite. Its assistant integrations also lack repository-level hooks, rules, CI, and a measurable harness acceptance gate, which makes safe parallel maintenance difficult.

## Goals

- [x] Run every application and TLC executable as strict TypeScript through `tsx` with no emitted output.
- [x] Preserve all observable application, CLI, log, scraper, and validator behavior.
- [x] Add isolated Vitest coverage and deterministic local/CI gates.
- [x] Raise the pinned harness score from 41/108 to at least 70%, achieving 105/108.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Deploy, push, or pull request | Delivery beyond local commits was not authorized. |
| Live Google, Anthropic, Telegram, SSH, or EC2 calls | External mutation and nondeterminism are excluded. |
| Runtime behavior upgrades | Selectors, model, prompt, alert policy, schedule, delays, and persistence must remain stable. |
| MCP configuration for three residual points | The projected score already exceeds the product threshold. |
| Compiled output or bundles | TypeScript executes directly with `tsx`. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Node baseline | `>=20.19.0` | Supports `process.loadEnvFile` and ESLint 10. | yes |
| Package manager | pnpm 11.5.1 in CI | Matches the verified local environment and lockfile workflow. | yes |
| Parallel execution | At most three Terra-medium workers in isolated worktrees | Preserves orchestrator context and prevents shared-tree races. | yes |
| Harness product gate | `score.percent >= 70` | Detector-specific perfection is not required. | yes |
| External smoke test | Optional and never part of CI | It consumes paid/external services and is nondeterministic. | yes |

**Open questions:** none — all resolved by the approved implementation plan.

## User Stories

### P1: Strict TypeScript runtime and safe behavior preservation ⭐ MVP

**User Story**: As the Flightbot operator, I want application and operational code to run as strict TypeScript so that defects are caught without changing production behavior.

**Why P1**: The runtime migration is the foundation for every test and harness gate.

**Acceptance Criteria**:

1. WHEN `pnpm run typecheck` executes THEN the repository SHALL pass with strict no-emit checking over runtime, operational, test, and TLC TypeScript files. <!-- HTM-01 -->
2. The application SHALL execute `.ts` entrypoints through `tsx` without a `dist/` or emission step. <!-- HTM-02 -->
3. WHEN `pnpm test` executes THEN Vitest SHALL cover the migrated business branches without Google, Anthropic, Telegram, SSH, or EC2 calls. <!-- HTM-03 -->
4. WHEN route, status, and smoke CLIs run THEN the system SHALL preserve their arguments, JSON, error text, exit codes, and parsed-log behavior. <!-- HTM-04 -->
5. WHEN each migrated TLC CLI runs against its fixture corpus THEN it SHALL preserve Python exit codes, streams, resolution, and mutations. <!-- HTM-05 -->
6. The completed tree SHALL contain no Python executables and no references to the six former application JavaScript paths. <!-- HTM-06 -->

**Independent Test**: Run the full local gate, search for obsolete paths and Python files, and boot the inactive-route configuration with fake credentials.

### P1: Agent guardrails and reusable operating context ⭐ MVP

**User Story**: As a maintainer using multiple assistants, I want repository-scoped safety and diagnostic instructions so that agent actions remain bounded and consistent.

**Why P1**: Parallel execution is only safe when dangerous operations and public contracts are explicit.

**Acceptance Criteria**:

1. WHEN the Claude PreToolUse hook receives a destructive command THEN it SHALL deny recursive removal, hard reset, and force-push and SHALL request confirmation for deploy, Docker removal, and Compose shutdown. <!-- HTM-07 -->
2. WHEN Claude edits a TypeScript or JavaScript file THEN the PostToolUse hook SHALL attempt formatting and lint repair non-fatally for that file. <!-- HTM-08 -->
3. The repository SHALL document scraper, terminal UI, and parsed-log contracts in canonical path-scoped rules exposed to Claude, Cursor, and Windsurf. <!-- HTM-09 -->
4. The repository SHALL provide route-management and deploy-safety skills plus a diagnostic-only scrape-debugger agent. <!-- HTM-10 -->

**Independent Test**: Feed allow, ask, deny, malformed, extension-filter, and formatter-failure fixtures to the hooks and resolve all rule/skill links.

### P1: Deterministic quality and integration gates ⭐ MVP

**User Story**: As the repository owner, I want one reproducible local and CI quality contract so that parallel commits can be integrated confidently.

**Why P1**: The migration is not complete until it is continuously enforceable.

**Acceptance Criteria**:

1. WHEN CI runs THEN it SHALL install from the lockfile and execute tests, typechecking, linting, formatting, shell syntax checks, and the harness threshold. <!-- HTM-11 -->
2. WHEN `pnpm run harness:check` executes THEN it SHALL fail below 70 percent and pass at or above 70 percent. <!-- HTM-12 -->
3. The migration SHALL preserve config, prices, environment, logs, selectors, model/prompt, alerts, schedule, and rate limits. <!-- HTM-13 -->
4. IF a live scrape smoke test is authorized and credentials exist THEN it SHALL use `--no-send --json`; Telegram delivery and deployment SHALL remain excluded. <!-- HTM-14 -->
5. AFTER implementation commits are complete THEN a fresh Terra-medium verifier SHALL produce per-requirement file-line evidence and kill at least five behavior mutations. <!-- HTM-15 -->

**Independent Test**: Run every local gate from a clean checkout, build and inspect the Docker image, then execute the independent verifier in a temporary worktree.

## Edge Cases

- IF Claude returns no text content block THEN the scraper SHALL throw an explicit extraction error.
- IF a stale run lock exists THEN the bot SHALL recover according to the current lock-age contract without overlapping active runs.
- IF a status log contains incomplete or malformed price data THEN the formatter SHALL preserve the current verdict and issue semantics.
- IF a hook receives malformed JSON THEN it SHALL fail safely without authorizing a destructive action.
- WHEN harness JSON reports 69.99 percent THEN the threshold CLI SHALL exit non-zero.
- WHEN a TLC target is missing or ambiguous THEN the migrated CLI SHALL preserve exit code 2 and diagnostic routing.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| HTM-01 | P1: strict runtime | Validation | Verified |
| HTM-02 | P1: strict runtime | Validation | Verified |
| HTM-03 | P1: strict runtime | Validation | Verified |
| HTM-04 | P1: strict runtime | Validation | Verified |
| HTM-05 | P1: strict runtime | Validation | Verified |
| HTM-06 | P1: strict runtime | Validation | Verified |
| HTM-07 | P1: guardrails | Validation | Verified |
| HTM-08 | P1: guardrails | Validation | Verified |
| HTM-09 | P1: guardrails | Validation | Verified |
| HTM-10 | P1: guardrails | Validation | Verified |
| HTM-11 | P1: quality gates | Validation | Verified |
| HTM-12 | P1: quality gates | Validation | Verified |
| HTM-13 | P1: quality gates | Validation | Verified |
| HTM-14 | P1: quality gates | Validation | Verified |
| HTM-15 | P1: quality gates | Validation | Verified |

**Coverage:** 15 total, 15 mapped to tasks, 0 unmapped.

## Success Criteria

- [x] `pnpm run check`, shell syntax checks, TLC validation, Docker verification, inactive-route boot, and `git diff --check` pass.
- [x] No Python executable or obsolete JavaScript application path remains.
- [x] `pnpm run harness:check` reports at least 70 percent.
- [x] Independent validation is PASS with at least five killed mutations.
