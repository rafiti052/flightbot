#!/usr/bin/env bash

input="$(cat)"
if ! command -v jq >/dev/null 2>&1 || ! file_path="$(printf '%s' "$input" | jq -er '.tool_input.file_path | strings' 2>/dev/null)"; then
  exit 0
fi

case "$file_path" in
  *.ts|*.js) ;;
  *) exit 0 ;;
esac

repo_root="$(cd "${CLAUDE_PROJECT_DIR:-$PWD}" && pwd -P)"
if [[ "$file_path" != /* ]]; then
  file_path="$repo_root/$file_path"
fi

[[ -f "$file_path" ]] || exit 0
file_path="$(cd "$(dirname "$file_path")" && pwd -P)/$(basename "$file_path")"
case "$file_path" in
  "$repo_root"/*) ;;
  *) exit 0 ;;
esac

pnpm exec prettier --write "$file_path" >/dev/null 2>&1 || true
pnpm exec eslint --fix "$file_path" >/dev/null 2>&1 || true
exit 0
