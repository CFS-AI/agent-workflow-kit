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

const { readSpentUsd, recordSpendUsd } = require("../templates/claude/hooks/ledger.js");

const LEDGER_MODULE = path.resolve(__dirname, "../templates/claude/hooks/ledger.js");

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kit-ledger-"));
  return path.join(dir, "cache", "provider-spend.jsonl");
}

function recordInChild(file, usd, times) {
  const script = `
    const { recordSpendUsd } = require(${JSON.stringify(LEDGER_MODULE)});
    for (let i = 0; i < ${times}; i += 1) recordSpendUsd(${JSON.stringify(file)}, ${usd});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
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

test("a corrupt line does not erase the spend recorded around it", () => {
  const file = tempLedger();
  recordSpendUsd(file, 1.37);
  fs.appendFileSync(file, "{ not json\n");
  recordSpendUsd(file, 2.74);
  assert.equal(readSpentUsd(file).toFixed(2), "4.11");
});
