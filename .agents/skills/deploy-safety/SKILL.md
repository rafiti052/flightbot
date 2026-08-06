---
name: deploy-safety
description: Safely assess or deploy Flightbot to its EC2 container. Use when a user asks about deployment readiness, production status, container restart, Docker removal, or running the repository deploy script.
---

# Deployment Safety

Default to read-only preflight. Inspect the local diff, run syntax or test checks, and explain expected impact without contacting SSH, EC2, or Docker.

## Classify the request

- Local checks: `git status`, TypeScript checks, shell syntax, and documentation review are read-only.
- Status checks: local status inspection is read-only; an SSH or remote Docker status command is an external action and needs explicit authorization and credentials.
- Mutations: `scripts/deploy.sh`, `docker-compose down`, `docker-compose up`, `docker rm`, `docker system prune`, and remote commands change infrastructure or service state.

Never infer approval for a mutation from a request to inspect, diagnose, or prepare. Do not run SSH, EC2, Docker, or Compose commands as a hidden side effect of a preflight.

## Deploy only after a final human gate

First state the exact command and effects: `scripts/deploy.sh` syncs code, rebuilds the remote image, restarts the container, and leaves `config.json`, `prices.json`, and `results.log` untouched. Use `scripts/deploy.sh --no-cache` only when requested or when dependencies changed.

Immediately before running either deploy command, ask for explicit confirmation. Do not proceed without it. On confirmation, run only the agreed command, report its result, and stop on failure. Never remove containers, volumes, images, or services unless the user explicitly names that destructive operation and confirms it immediately beforehand.
