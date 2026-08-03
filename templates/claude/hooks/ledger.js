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
const { randomUUID } = require("crypto");

const RESERVATION_LOCK_WAIT_MS = 1_000;
const RESERVATION_LOCK_POLL_MS = 10;
const RESERVATION_LOCK_STALE_DEFAULT_MS = 5_000;

/**
 * How long a lease may sit untouched before another process may reclaim it.
 *
 * Read per call rather than at load, so a suite can drive the reclaim path deliberately
 * instead of waiting seconds for it. A hold is a read plus an append — milliseconds — so
 * the default is three orders of magnitude of headroom, not a tuning knob.
 */
function staleAfterMs(env = process.env) {
  const value = Number(env.AGENT_KIT_LEDGER_STALE_MS);
  return Number.isFinite(value) && value >= 0 ? value : RESERVATION_LOCK_STALE_DEFAULT_MS;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  fs.appendFileSync(file, `${JSON.stringify({ ts: at, usd: amount })}\n`);
  return readSpentUsd(file);
}

/**
 * Reserve a bounded paid call before it begins.
 *
 * An append-only ledger prevents lost writes but not the "both calls read $0" race.
 * The short file lock covers only read+reservation; it has a fixed wait and a stale
 * lease, so contention degrades to the subscription fallback rather than wedging a
 * hook. A reservation is intentionally never removed when a process dies: retaining
 * the maximum possible charge is safer than spending past the ceiling.
 *
 * The lease carries a token because a stale lease can be reclaimed from a holder that
 * only looked dead. A holder that stalls past the stale window and then wakes up would
 * otherwise write a reservation computed from a read the reclaimer has already
 * invalidated — two calls reading $0, both fitting under the ceiling, together over it.
 * So ownership is re-checked around the write — before it to skip the reservation, and
 * after it to give one back that landed anyway — and a holder that lost its lease
 * reserves nothing either way.
 */
function reserveSpendUsd(file, usd, ceiling, at = Date.now()) {
  const amount = Number(usd);
  const limit = Number(ceiling);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(limit) || limit <= 0) {
    return { ok: false, reason: "invalid paid-call reservation" };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = `${file}.reservation-lock`;
  const token = randomUUID();
  const holdsLease = () => {
    try { return fs.readFileSync(lockFile, "utf8") === token; }
    catch { return false; }
  };
  const deadline = Date.now() + RESERVATION_LOCK_WAIT_MS;
  let acquired = false;
  while (Date.now() <= deadline) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, token);
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleAfterMs()) fs.unlinkSync(lockFile);
      } catch {}
      sleepSync(RESERVATION_LOCK_POLL_MS);
    }
  }
  if (!acquired) return { ok: false, reason: "spend ledger is busy; paid call skipped" };

  try {
    const spent = readSpentUsd(file);
    if (!Number.isFinite(spent) || spent + amount > limit) {
      return { ok: false, reason: "budget ceiling would be exceeded by paid-call reservation" };
    }
    if (!holdsLease()) return { ok: false, reason: "paid-call reservation lost its lease" };
    fs.appendFileSync(file, `${JSON.stringify({ ts: at, usd: amount, kind: "reservation" })}\n`);
    // Checking ownership before the write leaves the write itself unguarded: a holder
    // descheduled between the two lines still lands a reservation the reclaimer's read
    // never saw. Nothing has been called yet at this point, so a lease lost across the
    // append is undone by releasing it — the money is back before it could be spent.
    if (!holdsLease()) {
      fs.appendFileSync(file, `${JSON.stringify({ ts: at, usd: -amount, kind: "release" })}\n`);
      return { ok: false, reason: "paid-call reservation lost its lease" };
    }
    return { ok: true, reservedUsd: amount };
  } finally {
    // Only ever release our own lease; the reclaimer's lock is not ours to delete.
    try { if (holdsLease()) fs.unlinkSync(lockFile); } catch {}
  }
}

/** Reconcile a reservation to the measured charge; negative entries release unused headroom. */
function settleReservedSpendUsd(file, reservedUsd, actualUsd, at = Date.now()) {
  const reserved = Number(reservedUsd);
  const actual = Number(actualUsd);
  if (!Number.isFinite(reserved) || reserved <= 0 || !Number.isFinite(actual) || actual < 0) return readSpentUsd(file);
  const adjustment = actual - reserved;
  if (adjustment === 0) return readSpentUsd(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: at, usd: adjustment, kind: "settlement" })}\n`);
  return readSpentUsd(file);
}

module.exports = { readSpentUsd, recordSpendUsd, reserveSpendUsd, settleReservedSpendUsd };
