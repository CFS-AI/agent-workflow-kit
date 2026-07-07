#!/bin/bash
set -euo pipefail

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
  shift
fi

TARGET="${1:?usage: apply-kit.sh [--force] /path/to/project}"
KIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$TARGET" ]; then
  echo "target does not exist: $TARGET" >&2
  exit 2
fi

copy_one() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && [ "$FORCE" != "1" ]; then
    echo "skip existing: ${dst#$TARGET/}"
    return
  fi
  cp "$src" "$dst"
  echo "write: ${dst#$TARGET/}"
}

copy_one "$KIT_ROOT/templates/claude/CLAUDE.md" "$TARGET/CLAUDE.md"
copy_one "$KIT_ROOT/templates/claude/AGENTS.md" "$TARGET/AGENTS.md"
copy_one "$KIT_ROOT/templates/claude/settings.json" "$TARGET/.claude/settings.json"
copy_one "$KIT_ROOT/templates/claude/skills/skill-rules.json" "$TARGET/.claude/skills/skill-rules.json"
copy_one "$KIT_ROOT/templates/claude/skills/codex-delegate/SKILL.md" "$TARGET/.claude/skills/codex-delegate/SKILL.md"

for hook in "$KIT_ROOT"/templates/claude/hooks/*; do
  copy_one "$hook" "$TARGET/.claude/hooks/$(basename "$hook")"
  chmod +x "$TARGET/.claude/hooks/$(basename "$hook")"
done

copy_one "$KIT_ROOT/templates/scaffold/context.md" "$TARGET/.scaffold/context.md"
copy_one "$KIT_ROOT/templates/scaffold/rules.md" "$TARGET/.scaffold/rules.md"
copy_one "$KIT_ROOT/templates/scaffold/constraints.md" "$TARGET/.scaffold/constraints.md"
copy_one "$KIT_ROOT/templates/scaffold/done-criteria.md" "$TARGET/.scaffold/done-criteria.md"
copy_one "$KIT_ROOT/templates/scaffold/skills/catalog.json" "$TARGET/.scaffold/skills/catalog.json"
for card in "$KIT_ROOT"/templates/scaffold/skills/*.md; do
  copy_one "$card" "$TARGET/.scaffold/skills/$(basename "$card")"
done

copy_one "$KIT_ROOT/scripts/codex-exec.sh" "$TARGET/scripts/dev/codex-exec.sh"
chmod +x "$TARGET/scripts/dev/codex-exec.sh"

mkdir -p "$TARGET/dev/daily" "$TARGET/dev/codex-tasks"
touch "$TARGET/dev/daily/.gitkeep" "$TARGET/dev/codex-tasks/.gitkeep"
if [ ! -e "$TARGET/dev/status.md" ] || [ "$FORCE" = "1" ]; then
  cat > "$TARGET/dev/status.md" <<'STATUS'
# Project Status

Newest updates first. Keep this file concise and durable.

## Current state

- TODO: summarize project state.

## Open work

- [ ] TODO: first task.
STATUS
  echo "write: dev/status.md"
else
  echo "skip existing: dev/status.md"
fi

copy_one "$KIT_ROOT/.scrub-denylist" "$TARGET/.scrub-denylist"

echo "done. Customize TODO placeholders, then run scripts/scrub-check.sh and your tests."
