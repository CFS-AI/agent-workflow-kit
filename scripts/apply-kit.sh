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

# Set by copy_one to 1 when it actually wrote, 0 when it left an existing file
# alone. The pack merge below reads it: a merge that runs on every invocation
# would undo the customization INSTALL.md tells developers to make.
LAST_COPY_WROTE=0

copy_one() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && [ "$FORCE" != "1" ]; then
    echo "skip existing: ${dst#$TARGET/}"
    LAST_COPY_WROTE=0
    return
  fi
  cp "$src" "$dst"
  echo "write: ${dst#$TARGET/}"
  LAST_COPY_WROTE=1
}

copy_one "$KIT_ROOT/templates/claude/CLAUDE.md" "$TARGET/CLAUDE.md"
copy_one "$KIT_ROOT/templates/claude/AGENTS.md" "$TARGET/AGENTS.md"
copy_one "$KIT_ROOT/templates/claude/settings.json" "$TARGET/.claude/settings.json"
copy_one "$KIT_ROOT/templates/claude/skills/skill-rules.json" "$TARGET/.claude/skills/skill-rules.json"
copy_one "$KIT_ROOT/templates/claude/skills/codex-delegate/SKILL.md" "$TARGET/.claude/skills/codex-delegate/SKILL.md"

# chmod only on files we just wrote. Doing it unconditionally restores an
# executable bit the developer deliberately cleared — a personal setting the
# installer promises not to touch, and one no content diff can see.
for hook in "$KIT_ROOT"/templates/claude/hooks/*; do
  copy_one "$hook" "$TARGET/.claude/hooks/$(basename "$hook")"
  if [ "$LAST_COPY_WROTE" = "1" ]; then
    chmod +x "$TARGET/.claude/hooks/$(basename "$hook")"
  fi
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
if [ "$LAST_COPY_WROTE" = "1" ]; then
  chmod +x "$TARGET/scripts/dev/codex-exec.sh"
fi
copy_one "$KIT_ROOT/scripts/setup-codex-mcp.sh" "$TARGET/scripts/dev/setup-codex-mcp.sh"
if [ "$LAST_COPY_WROTE" = "1" ]; then
  chmod +x "$TARGET/scripts/dev/setup-codex-mcp.sh"
fi

mkdir -p "$TARGET/dev/daily" "$TARGET/dev/codex-tasks"
# Создаём, но не «трогаем»: touch по существующему файлу двигает mtime, и сборка
# или наблюдатель за файлами видят изменение, которого не было.
for keep in "$TARGET/dev/daily/.gitkeep" "$TARGET/dev/codex-tasks/.gitkeep"; do
  [ -e "$keep" ] || : > "$keep"
done
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

# merge_cfs_json <skill-id>... — add hints for exactly the named skills.
#
# The skill list is an argument, not a constant, because the two pack skills are
# installed independently. Merging both whenever any one of them is written
# means restoring a single missing card also resurrects the other skill's hint —
# including one the developer had deliberately deleted.
merge_cfs_json() {
  python3 - "$TARGET" "$@" <<'PY'
import json
import sys
from pathlib import Path

target = Path(sys.argv[1])
wanted = set(sys.argv[2:])


def write_if_changed(path, data, changed):
    """Rewrite only on a real change.

    `changed` is whether we actually appended anything — not whether the
    serialized text differs. A file the developer reformatted by hand serializes
    differently while carrying identical data, and rewriting it there would be
    exactly the silent overwrite this function exists to prevent.
    """
    if not changed:
        return
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


rules_path = target / ".claude/skills/skill-rules.json"
rules = json.loads(rules_path.read_text(encoding="utf-8"))
existing = {r.get("skill") for r in rules.get("rules", [])}
rules_changed = False
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
    if item["skill"] in wanted and item["skill"] not in existing:
        rules.setdefault("rules", []).append(item)
        rules_changed = True
write_if_changed(rules_path, rules, rules_changed)

catalog_path = target / ".scaffold/skills/catalog.json"
catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
existing = {s.get("id") for s in catalog.get("skills", [])}
catalog_changed = False
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
    if item["id"] in wanted and item["id"] not in existing:
        catalog.setdefault("skills", []).append(item)
        catalog_changed = True
write_if_changed(catalog_path, catalog, catalog_changed)
PY
}

if [ ${#PACKS[@]} -gt 0 ]; then
  for pack in "${PACKS[@]}"; do
    case "$pack" in
      cfs)
        # Подсказка о навыке дописывается только вместе с самим навыком, и
        # только о нём. INSTALL.md прямо предлагает удалять ненужные навыки из
        # skill-rules.json — безусловное слияние возвращало их обратно при
        # каждом запуске, а слияние «оба навыка, если записан хоть один» вернуло
        # бы удалённое при починке второго. Разработчик правит файл, установщик
        # молча отменяет правку: ровно то, чего не должно случиться.
        merge_skills=()
        for skill in cfs-hub-ops cfs-docs-update; do
          wrote=0
          copy_one "$KIT_ROOT/packs/cfs/claude/skills/$skill/SKILL.md" "$TARGET/.claude/skills/$skill/SKILL.md"
          if [ "$LAST_COPY_WROTE" = "1" ]; then wrote=1; fi
          copy_one "$KIT_ROOT/packs/cfs/scaffold/skills/$skill.md" "$TARGET/.scaffold/skills/$skill.md"
          if [ "$LAST_COPY_WROTE" = "1" ]; then wrote=1; fi
          if [ "$wrote" = "1" ] || [ "$FORCE" = "1" ]; then
            merge_skills+=("$skill")
          fi
        done
        copy_one "$KIT_ROOT/packs/cfs/.mcp.cfs.example.json" "$TARGET/.mcp.cfs.example.json"
        copy_one "$KIT_ROOT/packs/cfs/docs/CFS_PACK.md" "$TARGET/docs/CFS_PACK.md"
        if [ ${#merge_skills[@]} -gt 0 ]; then
          merge_cfs_json "${merge_skills[@]}"
          echo "pack installed: cfs (${merge_skills[*]})"
        else
          echo "pack already present: cfs (списки навыков не трогаю)"
        fi
        ;;
      *)
        echo "unknown pack: $pack" >&2
        exit 2
        ;;
    esac
  done
fi

echo "done. Customize TODO placeholders, then run scripts/scrub-check.sh and your tests."
