# Specification State

## Current Feature

- `harness-typescript-migration` — Approved, implementation in progress.

## Decisions

### AD-001: Execute TypeScript directly

- **Status**: active
- **Decision**: Use strict TypeScript with `tsx`, `noEmit`, explicit `.ts` imports, and no generated `dist/` tree.
- **Reason**: Preserve the repository's script-like runtime and Docker shape while adding static checking.

### AD-002: Keep external behavior stable

- **Status**: active
- **Decision**: Treat CLI output, exit status, logs, selectors, model/prompt, alert state, schedules, and delays as migration contracts.
- **Reason**: This feature is a language and harness migration, not a product behavior change.

### AD-003: Deterministic verification only

- **Status**: active
- **Decision**: Tests and CI must not call Google, Anthropic, Telegram, SSH, or EC2.
- **Reason**: Local and CI gates must be reproducible and safe.

## Features

| Feature | Status | Spec | Design | Tasks |
| --- | --- | --- | --- | --- |
| harness-typescript-migration | Implementing | `features/harness-typescript-migration/spec.md` | `features/harness-typescript-migration/design.md` | `features/harness-typescript-migration/tasks.md` |
