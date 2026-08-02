#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_PARENT="${TMPDIR:-/tmp}"
DEMO="$(mktemp -d "$TMP_PARENT/agent-workflow-demo.XXXXXX")"
trap 'rm -rf "$DEMO"' EXIT

mkdir -p "$DEMO/project"
echo "# Demo" > "$DEMO/project/README.md"

APPLY_ARGS=()
if [ "${AGENT_WORKFLOW_SMOKE_PACKS:-}" != "" ]; then
  IFS=',' read -r -a packs <<< "$AGENT_WORKFLOW_SMOKE_PACKS"
  for pack in "${packs[@]}"; do
    APPLY_ARGS+=("--pack" "$pack")
  done
fi

if [ ${#APPLY_ARGS[@]} -gt 0 ]; then
  "$ROOT/scripts/apply-kit.sh" "${APPLY_ARGS[@]}" "$DEMO/project" >/tmp/agent-workflow-apply.log
else
  "$ROOT/scripts/apply-kit.sh" "$DEMO/project" >/tmp/agent-workflow-apply.log
fi

required=(
  "CLAUDE.md"
  "AGENTS.md"
  ".claude/settings.json"
  ".claude/hooks/session-start.sh"
  ".claude/hooks/session-checkpoint.js"
  ".claude/hooks/skill-activation.js"
  ".claude/hooks/codex-copilot.js"
  ".claude/skills/codex-delegate/SKILL.md"
  ".scaffold/context.md"
  ".scaffold/rules.md"
  ".scaffold/constraints.md"
  ".scaffold/done-criteria.md"
  ".scaffold/skills/catalog.json"
  "scripts/dev/codex-exec.sh"
  "scripts/dev/setup-codex-mcp.sh"
  "dev/status.md"
)

for file in "${required[@]}"; do
  test -e "$DEMO/project/$file" || { echo "missing: $file" >&2; exit 1; }
done

if [[ ",${AGENT_WORKFLOW_SMOKE_PACKS:-}," == *",cfs,"* ]]; then
  cfs_required=(
    ".claude/skills/cfs-hub-ops/SKILL.md"
    ".claude/skills/cfs-docs-update/SKILL.md"
    ".scaffold/skills/cfs-hub-ops.md"
    ".scaffold/skills/cfs-docs-update.md"
    ".mcp.cfs.example.json"
    "docs/CFS_PACK.md"
  )
  for file in "${cfs_required[@]}"; do
    test -e "$DEMO/project/$file" || { echo "missing CFS pack file: $file" >&2; exit 1; }
  done
  node -e "JSON.parse(require('fs').readFileSync('$DEMO/project/.mcp.cfs.example.json','utf8'))"
  grep -q 'cfs-hub-ops' "$DEMO/project/.claude/skills/skill-rules.json"
  grep -q 'cfs-docs-update' "$DEMO/project/.scaffold/skills/catalog.json"
fi

node -e "JSON.parse(require('fs').readFileSync('$DEMO/project/.claude/settings.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('$DEMO/project/.claude/skills/skill-rules.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('$DEMO/project/.scaffold/skills/catalog.json','utf8'))"

chmod +x "$DEMO/project/.claude/hooks/session-start.sh" "$DEMO/project/scripts/dev/codex-exec.sh"
bash "$DEMO/project/.claude/hooks/session-start.sh" >/tmp/agent-workflow-session-start.log
bash "$DEMO/project/scripts/dev/setup-codex-mcp.sh" --help >/tmp/agent-workflow-codex-mcp-help.log
grep -q 'gpt-5.6-luna' "$DEMO/project/scripts/dev/codex-exec.sh"
grep -q 'gpt-5.6-sol' "$DEMO/project/.claude/skills/codex-delegate/SKILL.md"
grep -q 'autonomous-work-loop' "$DEMO/project/.scaffold/skills/catalog.json"

# --- Re-running the installer must not undo the developer's own edits ---
#
# This is the one property the kit promises and nothing tested: copy_one has
# always skipped existing files, but the CFS pack merged its skill hints on
# every invocation. INSTALL.md tells developers to remove skills they do not
# use — and the next run silently put them back. A test that applies the kit
# once can never catch that.

printf '\n<!-- personal edit, must survive a re-run -->\n' >> "$DEMO/project/CLAUDE.md"

if [[ ",${AGENT_WORKFLOW_SMOKE_PACKS:-}," == *",cfs,"* ]]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    doc.rules = doc.rules.filter((r) => r.skill !== "cfs-hub-ops");
    fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
  ' "$DEMO/project/.claude/skills/skill-rules.json"
fi

cp -R "$DEMO/project" "$DEMO/before-second-run"

if [ ${#APPLY_ARGS[@]} -gt 0 ]; then
  "$ROOT/scripts/apply-kit.sh" "${APPLY_ARGS[@]}" "$DEMO/project" >/tmp/agent-workflow-apply-2.log
else
  "$ROOT/scripts/apply-kit.sh" "$DEMO/project" >/tmp/agent-workflow-apply-2.log
fi

if ! diff -r "$DEMO/before-second-run" "$DEMO/project"; then
  echo "re-running apply-kit.sh changed the target — personal edits are not safe" >&2
  exit 1
fi

if [[ ",${AGENT_WORKFLOW_SMOKE_PACKS:-}," == *",cfs,"* ]]; then
  if grep -q 'cfs-hub-ops' "$DEMO/project/.claude/skills/skill-rules.json"; then
    echo "re-run resurrected a skill hint the developer had removed" >&2
    exit 1
  fi
fi

"$ROOT/scripts/scrub-check.sh"

echo "smoke-test: OK ($DEMO/project)"
