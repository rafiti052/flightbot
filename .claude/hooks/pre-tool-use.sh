#!/usr/bin/env bash

emit_decision() {
  local decision="$1"
  local reason="$2"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' "$decision" "$reason"
}

input="$(cat)"
if ! command -v jq >/dev/null 2>&1 || ! command="$(printf '%s' "$input" | jq -er '.tool_input.command | strings' 2>/dev/null)"; then
  emit_decision deny "Could not safely read the Bash command."
  exit 0
fi

is_direct_command() {
  local program="$1"
  [[ "$command" =~ (^|[\;\&\|])[[:space:]]*(sudo[[:space:]]+)?${program}([[:space:]]|$) ]]
}

if is_direct_command rm && { [[ "$command" =~ rm[[:space:]]+[^\;\&\|]*-[[:alnum:]]*[rR][[:alnum:]]*[fF] ]] || [[ "$command" =~ rm[[:space:]]+[^\;\&\|]*-[[:alnum:]]*[fF][[:alnum:]]*[rR] ]] || { [[ "$command" =~ rm[[:space:]]+[^\;\&\|]*--recursive ]] && [[ "$command" =~ rm[[:space:]]+[^\;\&\|]*--force ]]; }; }; then
  emit_decision deny "Recursive forced removal is blocked."
elif is_direct_command git && [[ "$command" =~ git[[:space:]]+reset[[:space:]]+[^\;\&\|]*--hard([[:space:]]|$) ]]; then
  emit_decision deny "Hard git resets are blocked."
elif is_direct_command git && [[ "$command" =~ git[[:space:]]+push([[:space:]]+[^\;\&\|]*)?[[:space:]]+(-f|--force|--force-with-lease)([[:space:]]|$) ]]; then
  emit_decision deny "Force pushes are blocked."
elif [[ "$command" =~ (^|[\;\&\|])[[:space:]]*((bash|sh)[[:space:]]+)?(\./)?scripts/deploy\.sh([[:space:]]|$) ]] || [[ "$command" =~ (^|[\;\&\|])[[:space:]]*(pnpm|npm)[[:space:]]+run[[:space:]]+deploy([[:space:]]|$) ]]; then
  emit_decision ask "Deployment requires explicit confirmation."
elif { is_direct_command docker && [[ "$command" =~ docker[[:space:]]+(rm|rmi|system[[:space:]]+prune|volume[[:space:]]+rm|compose[[:space:]]+down)([[:space:]]|$) ]]; } || { is_direct_command docker-compose && [[ "$command" =~ docker-compose[[:space:]]+down([[:space:]]|$) ]]; }; then
  emit_decision ask "Docker cleanup or shutdown requires explicit confirmation."
else
  emit_decision allow "Command is not covered by a safety guard."
fi
