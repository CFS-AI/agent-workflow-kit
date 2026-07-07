#!/bin/bash
set -u

STATUS_FILE="dev/status.md"
if [ -f "$STATUS_FILE" ]; then
  echo "📋 dev/status.md exists — review current state before starting."
else
  echo "⚠️ No dev/status.md found. Create one with current project state."
fi

DAILY_DATE=$(date -v-3H +%F 2>/dev/null || date +%F)
echo ""
echo "🗓 Daily ledger: dev/daily/${DAILY_DATE}.md"
echo "  Use sections: TODO · Done · Tracks."

if [ ! -f "dev/daily/${DAILY_DATE}.md" ]; then
  PREV_DAILY=$(ls dev/daily/????-??-??.md 2>/dev/null | grep -v "${DAILY_DATE}.md" | sort | tail -1)
  if [ -n "$PREV_DAILY" ]; then
    CARRYOVER=$(grep '^- \[ \]' "$PREV_DAILY" 2>/dev/null | head -10)
    if [ -n "$CARRYOVER" ]; then
      echo ""
      echo "📌 Carryover from ${PREV_DAILY}:"
      echo "$CARRYOVER"
    fi
  fi
fi

WR_STAMP="dev/daily/.weekly-review-stamp"
if [ ! -f "$WR_STAMP" ] || [ -z "$(find "$WR_STAMP" -mtime -7 2>/dev/null)" ]; then
  echo ""
  echo "📅 Weekly review may be stale (>7d). Consider reviewing daily/status patterns."
fi

echo ""
echo "🔒 Reminders: no secrets/private data in git; delegate routine work; review-gate before commit."
