#!/bin/bash
# Hardened wrapper for Codex CLI one-shot runs.
set -u

DIR=""
OUT=""
SANDBOX="read-only"
EFFORT="high"
MODEL="gpt-5.5"

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

CODEX_BIN="${CODEX_COPILOT_BIN:-$HOME/.local/bin/codex}"

run_once() {
  "$CODEX_BIN" -c mcp_servers='{}' -c model_reasoning_effort="$EFFORT" -m "$MODEL" \
    exec --sandbox "$SANDBOX" -C "$DIR" "$PROMPT" > "$OUT" 2>&1
}

run_once
RC=$?
if [ $RC -ne 0 ] && grep -q "Reconnecting\|stream disconnected" "$OUT" 2>/dev/null; then
  echo "[codex-exec] transient disconnect detected, retrying once..." >&2
  run_once
  RC=$?
fi
exit $RC
