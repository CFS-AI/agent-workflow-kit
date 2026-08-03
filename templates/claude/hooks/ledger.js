#!/usr/bin/env node
"use strict";

/**
 * Append-only spend ledger for metered provider calls.
 *
 * Spend used to be a single number inside the circuit-breaker state: read when a hook
 * started, written back after the call returned. Hooks fire concurrently, so that
 * read-modify-write lost updates — three invocations recorded 1.37 where 4.11 was
 * spent, and the ceiling stopped moving while the bill kept growing.
 *
 * Entries are therefore appended, never rewritten. Nothing else is needed for hooks to
 * share the file: each entry is one short `O_APPEND` write, which the kernel places at
 * the end of the file without the caller holding an offset, so concurrent recorders
 * cannot overwrite each other. A lock was tried here and removed — it guarded a race
 * the format had already eliminated, and its stale-reclaim path could spin forever on a
 * leftover directory `rmdir` refused to remove, hanging the whole turn.
 */

const fs = require("fs");
const path = require("path");

/** Total spend on record. A ledger that is missing or partly unreadable is not an error. */
function readSpentUsd(file) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return 0; }
  let total = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const usd = Number(JSON.parse(line).usd);
      if (Number.isFinite(usd)) total += usd;
    } catch {}
  }
  return total;
}

/** Append one metered call and return the new total. */
function recordSpendUsd(file, usd, at = Date.now()) {
  const amount = Number(usd);
  if (!Number.isFinite(amount) || amount <= 0) return readSpentUsd(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: at, usd: amount })}\n`);
  return readSpentUsd(file);
}

module.exports = { readSpentUsd, recordSpendUsd };
