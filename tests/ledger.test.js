"use strict";

/**
 * The spend ledger is the only thing standing between a paid provider and an
 * unbounded bill, and hooks fire concurrently. These tests drive it from separate
 * processes, because a single process cannot reproduce the interleaving that lost
 * updates in the first place.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { readSpentUsd, recordSpendUsd, reserveSpendUsd } = require("../templates/claude/hooks/ledger.js");

const LEDGER_MODULE = path.resolve(__dirname, "../templates/claude/hooks/ledger.js");

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kit-ledger-"));
  return path.join(dir, "cache", "provider-spend.jsonl");
}

function recordInChild(file, usd, times, timeoutMs = 30_000) {
  const script = `
    const { recordSpendUsd } = require(${JSON.stringify(LEDGER_MODULE)});
    for (let i = 0; i < ${times}; i += 1) recordSpendUsd(${JSON.stringify(file)}, ${usd});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: "inherit" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`recorder did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}`));
    });
  });
}

function reserveInChild(file, usd, ceiling, env = {}) {
  const script = `
    const { reserveSpendUsd } = require(${JSON.stringify(LEDGER_MODULE)});
    const result = reserveSpendUsd(${JSON.stringify(file)}, ${usd}, ${ceiling});
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, ...env },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`reservation child exited ${code}`));
      else resolve(JSON.parse(output));
    });
  });
}

test("an absent ledger reads as zero spend, not as an error", () => {
  assert.equal(readSpentUsd(tempLedger()), 0);
});

test("recorded spend accumulates", () => {
  const file = tempLedger();
  recordSpendUsd(file, 1.37);
  recordSpendUsd(file, 2.74);
  assert.equal(readSpentUsd(file).toFixed(2), "4.11");
});

test("concurrent recorders lose nothing", async () => {
  const file = tempLedger();
  await Promise.all([
    recordInChild(file, 1.37, 40),
    recordInChild(file, 1.37, 40),
    recordInChild(file, 1.37, 40),
  ]);

  // 3 hooks x 40 calls x 1.37 — the ceiling only works if every one of them lands.
  assert.equal(readSpentUsd(file).toFixed(2), "164.40");
});

test("concurrent reservations cannot collectively cross the budget ceiling", async () => {
  const file = tempLedger();
  const results = await Promise.all([
    reserveInChild(file, 3, 5),
    reserveInChild(file, 3, 5),
  ]);

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(readSpentUsd(file), 3);
});

test("a stray lock directory next to the ledger cannot wedge the recorder", async () => {
  const file = tempLedger();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockDir = `${file}.lock`;
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "stray"), "");
  const stale = new Date(Date.now() - 3_600_000);
  fs.utimesSync(lockDir, stale, stale);

  // A leftover directory rmdir cannot remove — non-empty, or owned by another user —
  // must not cost the hook more than the append itself. Recording spend runs
  // synchronously inside a Claude Code turn: anything unbounded here hangs the turn.
  await recordInChild(file, 1.37, 1, 5_000);
  assert.equal(readSpentUsd(file).toFixed(2), "1.37");
});

test("the ceiling holds even when every lease is instantly reclaimable", async () => {
  // The stale-lease reclaim exists so a dead process cannot wedge the ledger, but it also
  // fires on a holder that is merely slow — and that holder wakes with a read the
  // reclaimer has already invalidated. With a zero stale window every contender reclaims
  // whatever it finds, which is the same race at full strength: without an ownership
  // check before the write, several $3 reservations land under a $5 ceiling.
  const file = tempLedger();
  const instantlyStale = { AGENT_KIT_LEDGER_STALE_MS: "0" };
  const results = await Promise.all(
    Array.from({ length: 6 }, () => reserveInChild(file, 3, 5, instantlyStale)),
  );

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(readSpentUsd(file), 3);
  for (const result of results.filter((r) => !r.ok)) {
    assert.match(result.reason, /busy|ceiling|lease/);
  }
});

test("a blank stale window is an unset one, not an instantly reclaimable lease", async () => {
  // `Number("")` is 0, so `export AGENT_KIT_LEDGER_STALE_MS=` with nothing after it read
  // as "every lease is already stale" and turned the mutual exclusion off entirely.
  const blank = tempLedger();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => reserveInChild(blank, 3, 5, { AGENT_KIT_LEDGER_STALE_MS: "" })),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(readSpentUsd(blank), 3);

  // A lock left behind by a holder that died: an explicit 0 must still reclaim it, and
  // the blank value must behave like the default and refuse to.
  const zeroFile = tempLedger();
  fs.mkdirSync(path.dirname(zeroFile), { recursive: true });
  fs.writeFileSync(`${zeroFile}.reservation-lock`, "a-holder-that-died");
  const reclaimed = await reserveInChild(zeroFile, 1, 5, { AGENT_KIT_LEDGER_STALE_MS: "0" });
  assert.equal(reclaimed.ok, true, "an explicit zero window still reclaims an abandoned lease");

  const blankFile = tempLedger();
  fs.mkdirSync(path.dirname(blankFile), { recursive: true });
  fs.writeFileSync(`${blankFile}.reservation-lock`, "a-holder-that-died");
  const waited = await reserveInChild(blankFile, 1, 5, { AGENT_KIT_LEDGER_STALE_MS: "" });
  assert.equal(waited.ok, false, "a blank window waits out the default instead of reclaiming");
  assert.match(waited.reason, /busy/);
});

test("a lease lost across the write leaves no money reserved", () => {
  // Checking ownership before the append left the append itself unguarded: a holder
  // descheduled between those two lines still lands a reservation the reclaimer's read
  // never saw, and the ceiling is crossed by exactly that amount. Nothing has been
  // called at that point, so the reservation is given back rather than defended.
  const file = tempLedger();
  const lockFile = `${file}.reservation-lock`;
  const realAppend = fs.appendFileSync;
  let stolen = false;
  fs.appendFileSync = (target, data, ...rest) => {
    const result = realAppend.call(fs, target, data, ...rest);
    // The instant our reservation lands, another contender reclaims the lease.
    if (!stolen && target === file) {
      stolen = true;
      fs.writeFileSync(lockFile, "another-holder");
    }
    return result;
  };

  try {
    const result = reserveSpendUsd(file, 3, 5);
    assert.equal(result.ok, false);
    assert.match(result.reason, /lost its lease/);
    assert.equal(readSpentUsd(file), 0, "the reservation that landed anyway was released");
  } finally {
    fs.appendFileSync = realAppend;
  }
});

test("a corrupt line does not erase the spend recorded around it", () => {
  const file = tempLedger();
  recordSpendUsd(file, 1.37);
  fs.appendFileSync(file, "{ not json\n");
  recordSpendUsd(file, 2.74);
  assert.equal(readSpentUsd(file).toFixed(2), "4.11");
});
