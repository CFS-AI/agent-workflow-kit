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
 * Entries are therefore appended, never rewritten, and every write happens under a
 * directory lock: `mkdir` is atomic on every filesystem this runs on, which is all the
 * mutual exclusion a per-repository ledger needs.
 */

const fs = require("fs");
const path = require("path");

/** Longer than any provider call can take, so anything older is a killed hook's orphan. */
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` with the ledger held exclusively.
 *
 * If the lock cannot be taken within `LOCK_WAIT_MS` the work is done anyway: an
 * under-recorded entry is bad, a hook that refuses to record spend at all is worse.
 */
function withLock(lockDir, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      held = true;
      break;
    } catch {
      let age = 0;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { age = 0; }
      if (age > LOCK_STALE_MS) {
        try { fs.rmdirSync(lockDir); } catch {}
      } else {
        if (Date.now() > deadline) break;
        sleepSync(LOCK_POLL_MS);
      }
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try { fs.rmdirSync(lockDir); } catch {}
    }
  }
}

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
  return withLock(`${file}.lock`, () => {
    fs.appendFileSync(file, `${JSON.stringify({ ts: at, usd: amount })}\n`);
    return readSpentUsd(file);
  });
}

module.exports = { readSpentUsd, recordSpendUsd };
