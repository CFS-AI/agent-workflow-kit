"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  PROFILES,
  askCodex,
  choosePlanningProfile,
  isCircuitOpen,
} = require("../templates/claude/hooks/codex-copilot.js");
const { readSpentUsd } = require("../templates/claude/hooks/ledger.js");

const PAID_ENV = {
  AGENT_KIT_PROVIDER: "deepseek",
  AGENT_KIT_BUDGET_USD: "5",
  AGENT_KIT_MODEL_PRICES: '{"deepseek-reasoner":{"in":0.55,"out":2.19}}',
  DEEPSEEK_API_KEY: "test-key",
};

function withProjectRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kit-hook-"));
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  return Promise.resolve(fn(path.join(root, ".claude", "cache", "provider-spend.jsonl")))
    .finally(() => {
      if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previous;
    });
}

test("maps GPT-5.6 profiles by responsibility", () => {
  assert.deepEqual(PROFILES.prime, { model: "gpt-5.6-sol", effort: "xhigh" });
  assert.deepEqual(PROFILES.plan, { model: "gpt-5.6-terra", effort: "high" });
  assert.deepEqual(PROFILES.review, { model: "gpt-5.6-terra", effort: "high" });
  assert.deepEqual(PROFILES.build, { model: "gpt-5.6-luna", effort: "high" });
  assert.deepEqual(PROFILES.simple, { model: "gpt-5.6-luna", effort: "medium" });
});

test("escalates strategic prompts to Prime and normal planning to Plan", () => {
  assert.equal(choosePlanningProfile("Нужна стратегическая корректировка архитектуры"), "prime");
  assert.equal(choosePlanningProfile("Составь план миграции и укажи риски"), "plan");
});

test("opens the circuit only after repeated recent failures", () => {
  const now = 1_000_000;
  assert.equal(isCircuitOpen({ failures: [now - 1000, now - 2000, now - 3000] }, now), true);
  assert.equal(isCircuitOpen({ failures: [now - 1000, now - 400_000, now - 500_000] }, now), false);
});

test("what a metered call cost lands in the spend ledger", async () => {
  await withProjectRoot(async (ledgerFile) => {
    const note = await askCodex("tool-check", "check this", "review", 20, {
      env: PAID_ENV,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "APPROVE: nothing risky here" } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
        }),
      }),
    });

    assert.equal(note, "APPROVE: nothing risky here");
    assert.equal(readSpentUsd(ledgerFile).toFixed(2), "0.55");
  });
});

test("the ledger stops the routine before the ceiling is crossed, not after", async () => {
  await withProjectRoot(async (ledgerFile) => {
    let calls = 0;
    const deps = {
      // A million-token cap at $2.19/M is $2.19 of exposure per call.
      env: { ...PAID_ENV, AGENT_KIT_MAX_TOKENS: "1000000" },
      spawnSync: () => ({ status: 0, stdout: "APPROVE: codex answered", stderr: "" }),
      fetch: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "APPROVE: nothing risky here" } }],
            usage: { prompt_tokens: 0, completion_tokens: 1_000_000 },
          }),
        };
      },
    };

    for (let i = 0; i < 5; i += 1) await askCodex("tool-check", "check this", "review", 20, deps);

    // Two calls fit under $5; a third would land at $6.57, so it is never made.
    assert.equal(calls, 2);
    assert.equal(readSpentUsd(ledgerFile).toFixed(2), "4.38");
    assert.ok(readSpentUsd(ledgerFile) <= 5);
  });
});

test("a provider that omits usage cannot buy unlimited calls for $0", async () => {
  await withProjectRoot(async (ledgerFile) => {
    let calls = 0;
    const deps = {
      env: { ...PAID_ENV, AGENT_KIT_MAX_TOKENS: "1000000" },
      spawnSync: () => ({ status: 0, stdout: "APPROVE: codex answered", stderr: "" }),
      fetch: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "APPROVE: fine" } }] }),
        };
      },
    };

    for (let i = 0; i < 6; i += 1) await askCodex("tool-check", "check this", "review", 20, deps);

    assert.equal(calls, 2);
    assert.ok(readSpentUsd(ledgerFile) > 0);
  });
});
