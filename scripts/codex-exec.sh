#!/usr/bin/env bash
# Bounded Codex CLI wrapper for one delegated task.
set -euo pipefail

DIR=""
OUT=""
SANDBOX="read-only"
EFFORT="high"
MODEL="gpt-5.6-luna"

while getopts "C:o:s:e:m:" opt; do
  case "$opt" in
    C) DIR="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    s) SANDBOX="$OPTARG" ;;
    e) EFFORT="$OPTARG" ;;
    m) MODEL="$OPTARG" ;;
    *) echo "usage: codex-exec.sh -C <dir> -o <outfile> [-s sandbox] [-e effort] [-m model] '<prompt>'" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))

PROMPT="${1:?prompt required}"
: "${DIR:?-C dir required}"
: "${OUT:?-o outfile required}"
CODEX_BIN="${CODEX_BIN:-${CODEX_COPILOT_BIN:-codex}}"

command -v "$CODEX_BIN" >/dev/null 2>&1 || { echo "Codex CLI not found: $CODEX_BIN" >&2; exit 1; }

"$CODEX_BIN" -a never -c mcp_servers='{}' -c model_reasoning_effort="$EFFORT" -m "$MODEL" \
  exec --sandbox "$SANDBOX" -o "$OUT" -C "$DIR" "$PROMPT"
