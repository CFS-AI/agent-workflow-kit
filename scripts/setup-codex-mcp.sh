#!/usr/bin/env bash
set -euo pipefail

SCOPE="user"
CHECK_ONLY=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(basename "$SCRIPT_DIR")" = "dev" ]; then
  ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

usage() {
  cat <<'USAGE'
Usage: scripts/setup-codex-mcp.sh [--scope user|project] [--check]

Registers the safe stdio MCP transport:
  codex -> codex mcp-server

It never stores credentials and refuses to overwrite an existing MCP named codex
with a different command.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --scope)
      SCOPE="${2:?--scope requires user or project}"
      shift 2
      ;;
    --check)
      CHECK_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

case "$SCOPE" in user|project) ;; *) echo "invalid scope: $SCOPE" >&2; exit 2 ;; esac
command -v claude >/dev/null 2>&1 || { echo "Claude Code CLI is required" >&2; exit 1; }

claude_mcp() {
  if [ "$SCOPE" = "project" ]; then
    (cd "$ROOT" && claude mcp "$@")
  else
    claude mcp "$@"
  fi
}

details="$(claude_mcp get codex 2>/dev/null || true)"
if printf '%s\n' "$details" | grep -q 'Command: codex' && printf '%s\n' "$details" | grep -q 'Args: mcp-server'; then
  echo "PASS: Codex MCP is registered as codex mcp-server."
  exit 0
fi

if [ -n "$details" ]; then
  echo "Refusing to overwrite existing MCP named codex; inspect it manually." >&2
  exit 1
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo "FAIL: Codex MCP is not registered." >&2
  exit 1
fi

command -v codex >/dev/null 2>&1 || { echo "Codex CLI is required" >&2; exit 1; }
if [ "$SCOPE" = "project" ]; then
  claude_mcp add --scope project codex -- codex mcp-server
else
  claude_mcp add --scope user codex -- codex mcp-server
fi
echo "PASS: Codex MCP registered. Restart Claude Code before first MCP sync use."
