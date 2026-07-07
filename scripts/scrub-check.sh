#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DENYLIST="$ROOT/.scrub-denylist"

if [ ! -f "$DENYLIST" ]; then
  echo "missing denylist: $DENYLIST" >&2
  exit 2
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

grep -vE '^\s*(#|$)' "$DENYLIST" > "$TMP" || true
if [ ! -s "$TMP" ]; then
  echo "scrub-check: denylist empty"
  exit 0
fi

if grep -RInE -f "$TMP" "$ROOT" \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude=.scrub-denylist \
  --exclude='*.png' --exclude='*.jpg' --exclude='*.jpeg' --exclude='*.gif' \
  --exclude='scrub-check.sh'; then
  echo "scrub-check: potential private/sensitive markers found" >&2
  exit 1
fi

echo "scrub-check: OK"
