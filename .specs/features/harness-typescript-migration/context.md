# Flightbot TypeScript and Agent-Harness Migration Context

## Approved Decisions

- Preserve existing runtime behavior; this is not a scraper, model, alert, scheduling, or rate-limit redesign.
- Execute TypeScript directly with `tsx`; do not introduce compilation, bundling, generated output, or a Docker build stage.
- Use explicit `.ts` import specifiers with TypeScript bundler resolution and `allowImportingTsExtensions` under `noEmit`.
- Keep shared domain contracts in `types.ts`; keep CLI-only shapes local.
- Make every executable import-safe and inject filesystem, clock, console, network, browser, and process boundaries needed by deterministic tests.
- Retain public CLI text, JSON fields, exit status, and `results.log` parsing contracts byte-for-byte where practical.
- Pin `harness-score` exactly; the threshold is the product contract, while 105/108 is a projection.
- Use isolated worktrees and atomic commits. Workers may not widen file ownership or spawn subagents.

## Verified Baseline

- Node: 26.3.1 locally; supported minimum will be 20.19.0.
- pnpm: 11.5.1.
- Harness score: 41/108 after the installed TLC skill is detected.
- Test suite: absent.
- Application executables: six JavaScript files.
- TLC gates: five Python files.
- Confirmed TLC lessons: none.

## Package Decisions

| Role | Package line |
| --- | --- |
| Runtime | `tsx ^4.23.9` |
| Compiler/types | `typescript ~6.0.3`, `@types/node 22.20.1` |
| Tests | `vitest ^4.1.10`, `@vitest/coverage-v8 ^4.1.10` |
| Lint | `eslint ^10.8.0`, `typescript-eslint ^8.66.0`, `@eslint/js ^10.0.1`, `eslint-config-prettier ^10.1.8` |
| Format | `prettier ^3.9.6` |
| Git hooks | `lefthook ^2.1.10` |
| Sensor | `harness-score 1.5.2` |

**Verified pnpm 11.5.1 adjustment:** this release ignores `package.json#pnpm.onlyBuiltDependencies` and uses repository-level `pnpm-workspace.yaml#allowBuilds`. The equivalent allowlist is therefore committed there for `esbuild` and `lefthook`; the generated `minimumReleaseAgeExclude` entry pins the explicitly approved `tsx@4.23.9` through the active supply-chain policy.

## Safety Boundaries

- Do not deploy, push, open a PR, call Telegram, or mutate EC2.
- Do not mutate `config.json`, `prices.json`, `.env`, or `results.log`.
- Do not run an external scrape unless separately authorized; if authorized, force `--no-send --json`.
- Build Docker only as a local verification artifact named `flightbot-ts-verify`.
