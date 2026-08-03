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
  ".claude/hooks/providers.js"
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
# An installed workspace must route to the subscription transport until someone
# names a paid provider on purpose.
node -e "
  const p = require('$DEMO/project/.claude/hooks/providers.js');
  if (p.resolveProvider('review', {}) !== 'codex') { console.error('default routing is not codex'); process.exit(1); }
"
grep -q 'gpt-5.6-sol' "$DEMO/project/.claude/skills/codex-delegate/SKILL.md"
grep -q 'autonomous-work-loop' "$DEMO/project/.scaffold/skills/catalog.json"

"$ROOT/scripts/scrub-check.sh"

echo "smoke-test: OK ($DEMO/project)"
