#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_PARENT="${TMPDIR:-/tmp}"
DEMO="$(mktemp -d "$TMP_PARENT/agent-workflow-demo.XXXXXX")"
trap 'rm -rf "$DEMO"' EXIT

mkdir -p "$DEMO/project"
echo "# Demo" > "$DEMO/project/README.md"

"$ROOT/scripts/apply-kit.sh" "$DEMO/project" >/tmp/agent-workflow-apply.log

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
  "dev/status.md"
)

for file in "${required[@]}"; do
  test -e "$DEMO/project/$file" || { echo "missing: $file" >&2; exit 1; }
done

node -e "JSON.parse(require('fs').readFileSync('$DEMO/project/.claude/settings.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('$DEMO/project/.claude/skills/skill-rules.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('$DEMO/project/.scaffold/skills/catalog.json','utf8'))"

chmod +x "$DEMO/project/.claude/hooks/session-start.sh" "$DEMO/project/scripts/dev/codex-exec.sh"
bash "$DEMO/project/.claude/hooks/session-start.sh" >/tmp/agent-workflow-session-start.log

"$ROOT/scripts/scrub-check.sh"

echo "smoke-test: OK ($DEMO/project)"
