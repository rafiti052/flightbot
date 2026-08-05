# Claude Adapter

Follow the canonical workflow in [AGENTS.md](./AGENTS.md).

Claude-specific guidance:

- Slash commands are symlinks into `.agents/workflows/` — edit the canonical file there,
  never the symlink, so Codex and Cursor stay in sync.
- This repo deploys to a live EC2 host. Never run `scripts/deploy.sh` unless asked.
- Keep this file thin — policy lives only in `AGENTS.md`.
