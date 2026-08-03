#!/bin/bash
set -euo pipefail

FORCE=0
PACKS=()

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --force)
      FORCE=1
      shift
      ;;
    --pack)
      PACKS+=("${2:?--pack requires a pack name}")
      shift 2
      ;;
    --pack=*)
      PACKS+=("${1#--pack=}")
      shift
      ;;
    *)
      break
      ;;
  esac
done

TARGET="${1:?usage: apply-kit.sh [--force] [--pack cfs] /path/to/project}"
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
copy_one "$KIT_ROOT/scripts/setup-codex-mcp.sh" "$TARGET/scripts/dev/setup-codex-mcp.sh"
chmod +x "$TARGET/scripts/dev/setup-codex-mcp.sh"

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

# The hooks keep circuit-breaker state and the provider spend ledger under
# .claude/cache/. A committed ledger leaks how the workspace is used, and a merged
# one silently resets the budget ceiling, so the ignore is part of the install.
ensure_ignored() {
  local pattern="$1"
  local file="$TARGET/.gitignore"
  if [ -e "$file" ] && grep -qxF "$pattern" "$file"; then
    echo "skip existing: .gitignore ($pattern)"
    return
  fi
  if [ -e "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then
    echo "" >> "$file"
  fi
  echo "$pattern" >> "$file"
  echo "write: .gitignore ($pattern)"
}

ensure_ignored ".claude/cache/"

merge_cfs_json() {
  python3 - "$TARGET" <<'PY'
import json
import sys
from pathlib import Path

target = Path(sys.argv[1])

rules_path = target / ".claude/skills/skill-rules.json"
rules = json.loads(rules_path.read_text(encoding="utf-8"))
existing = {r.get("skill") for r in rules.get("rules", [])}
for item in [
    {
        "skill": "cfs-hub-ops",
        "triggers": {
            "keywords": ["cfs-hub", "hub_status", "infra", "инфра", "что упало", "incident"],
            "min_keyword_matches": 1,
            "always_load": False,
        },
        "priority": 20,
    },
    {
        "skill": "cfs-docs-update",
        "triggers": {
            "keywords": ["cfs docs", "docs-intel", "documentation", "runbook", "доки", "документация"],
            "min_keyword_matches": 1,
            "always_load": False,
        },
        "priority": 21,
    },
]:
    if item["skill"] not in existing:
        rules.setdefault("rules", []).append(item)
rules_path.write_text(json.dumps(rules, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

catalog_path = target / ".scaffold/skills/catalog.json"
catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
existing = {s.get("id") for s in catalog.get("skills", [])}
for item in [
    {
        "id": "cfs-hub-ops",
        "displayName": "CFS Hub Ops",
        "description": "Read-only CFS infra monitoring triage via cfs-hub MCP.",
        "bundled": False,
        "allowedRoles": ["compose", "review", "general"],
        "readOnly": True,
    },
    {
        "id": "cfs-docs-update",
        "displayName": "CFS Docs Update",
        "description": "Docs-first and docs-update workflow via CFS Docs/docs-intel.",
        "bundled": False,
        "allowedRoles": ["compose", "docs-writer", "general"],
    },
]:
    if item["id"] not in existing:
        catalog.setdefault("skills", []).append(item)
catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}

if [ ${#PACKS[@]} -gt 0 ]; then
  for pack in "${PACKS[@]}"; do
    case "$pack" in
      cfs)
        copy_one "$KIT_ROOT/packs/cfs/claude/skills/cfs-hub-ops/SKILL.md" "$TARGET/.claude/skills/cfs-hub-ops/SKILL.md"
        copy_one "$KIT_ROOT/packs/cfs/claude/skills/cfs-docs-update/SKILL.md" "$TARGET/.claude/skills/cfs-docs-update/SKILL.md"
        copy_one "$KIT_ROOT/packs/cfs/scaffold/skills/cfs-hub-ops.md" "$TARGET/.scaffold/skills/cfs-hub-ops.md"
        copy_one "$KIT_ROOT/packs/cfs/scaffold/skills/cfs-docs-update.md" "$TARGET/.scaffold/skills/cfs-docs-update.md"
        copy_one "$KIT_ROOT/packs/cfs/.mcp.cfs.example.json" "$TARGET/.mcp.cfs.example.json"
        copy_one "$KIT_ROOT/packs/cfs/docs/CFS_PACK.md" "$TARGET/docs/CFS_PACK.md"
        merge_cfs_json
        echo "pack installed: cfs"
        ;;
      *)
        echo "unknown pack: $pack" >&2
        exit 2
        ;;
    esac
  done
fi

echo "done. Customize TODO placeholders, then run scripts/scrub-check.sh and your tests."
