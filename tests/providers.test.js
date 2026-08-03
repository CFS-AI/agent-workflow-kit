"use strict";

/**
 * A paid provider brings two failure modes the CLI transport never had: a call can
 * cost money, and a response can be prose instead of a verdict. These tests pin both,
 * and they run without an API key and without touching the network — the transport is
 * injected.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  askProvider,
  checkBudget,
  estimateCostUsd,
  parseVerdict,
  resolveProvider,
} = require("../templates/claude/hooks/providers.js");

const ROUTE = { model: "deepseek-chat", effort: "high" };
const PRICES = JSON.stringify({ "deepseek-chat": { in: 0.27, out: 1.1 } });

const codexOk = () => ({ status: 0, stdout: "APPROVE: nothing risky here", stderr: "" });

function fakeFetch(payload, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => payload });
}

test("routing stays on Codex until a provider is named", () => {
  assert.equal(resolveProvider("review", {}), "codex");
  assert.equal(resolveProvider("review", { AGENT_KIT_PROVIDER: "deepseek" }), "deepseek");
  assert.equal(resolveProvider("review", { AGENT_KIT_PROVIDER: "nonsense" }), "codex");
});

test("a per-profile override moves one profile without moving the rest", () => {
  const env = { AGENT_KIT_PROVIDER: "codex", AGENT_KIT_PROVIDER_REVIEW: "deepseek" };
  assert.equal(resolveProvider("review", env), "deepseek");
  assert.equal(resolveProvider("build", env), "codex");
});

test("prose is not a verdict", () => {
  assert.deepEqual(parseVerdict("BLOCK: force push to main"), { ok: true, verdict: "BLOCK: force push to main" });
  assert.equal(parseVerdict("Looks reasonable to me, I would go ahead.").ok, false);
  assert.equal(parseVerdict("").ok, false);
});

test("the verdict is taken from the last line that carries one", () => {
  const parsed = parseVerdict("Some reasoning first.\nWARN: touches production config");
  assert.equal(parsed.verdict, "WARN: touches production config");
});

test("an unpriced model costs unknown, not zero", () => {
  assert.equal(estimateCostUsd("deepseek-chat", { prompt_tokens: 1000, completion_tokens: 100 }, {}), null);
  const priced = estimateCostUsd(
    "deepseek-chat",
    { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    JSON.parse(PRICES),
  );
  assert.equal(priced, 0.27 + 1.1);
});

test("a metered call is refused without a ceiling, without a price, or once spent", () => {
  assert.match(checkBudget("deepseek-chat", 0, { AGENT_KIT_MODEL_PRICES: PRICES }).reason, /ceiling not set/);
  assert.match(checkBudget("deepseek-chat", 0, { AGENT_KIT_BUDGET_USD: "5" }).reason, /no declared price/);
  assert.equal(checkBudget("deepseek-chat", 0, { AGENT_KIT_BUDGET_USD: "5", AGENT_KIT_MODEL_PRICES: PRICES }).ok, true);
  assert.match(
    checkBudget("deepseek-chat", 5, { AGENT_KIT_BUDGET_USD: "5", AGENT_KIT_MODEL_PRICES: PRICES }).reason,
    /ceiling reached/,
  );
});

test("a missing key escalates to the unmetered provider and says so", async () => {
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek" },
    { env: { AGENT_KIT_BUDGET_USD: "5", AGENT_KIT_MODEL_PRICES: PRICES }, spawnSync: codexOk },
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider, "codex");
  assert.equal(result.escalatedFrom, "deepseek");
  assert.match(result.escalationReason, /DEEPSEEK_API_KEY/);
});

test("an exhausted budget escalates before any request is made", async () => {
  let called = false;
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek", spentUsd: 99 },
    {
      env: { AGENT_KIT_BUDGET_USD: "5", AGENT_KIT_MODEL_PRICES: PRICES, DEEPSEEK_API_KEY: "unused" },
      spawnSync: codexOk,
      fetch: async () => { called = true; throw new Error("must not be called"); },
    },
  );

  assert.equal(called, false);
  assert.equal(result.escalatedFrom, "deepseek");
  assert.match(result.escalationReason, /ceiling reached/);
});

test("a healthy metered call returns the verdict and what it cost", async () => {
  const result = await askProvider(
    "planning-check",
    ROUTE,
    "review this plan",
    { provider: "deepseek" },
    {
      env: { AGENT_KIT_BUDGET_USD: "5", AGENT_KIT_MODEL_PRICES: PRICES, DEEPSEEK_API_KEY: "test-key" },
      fetch: fakeFetch({
        choices: [{ message: { content: "APPROVE: plan is bounded" } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider, "deepseek");
  assert.equal(result.verdict, "APPROVE: plan is bounded");
  assert.equal(result.costUsd, 0.27);
});

test("prose from a paid provider is a failed call, never a quiet APPROVE", async () => {
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek" },
    {
      env: { AGENT_KIT_BUDGET_USD: "5", AGENT_KIT_MODEL_PRICES: PRICES, DEEPSEEK_API_KEY: "test-key" },
      fetch: fakeFetch({
        choices: [{ message: { content: "Sure, that looks fine to me." } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.verdict, /^WARN:/);
  // The prose itself must not travel onward dressed as a verdict.
  assert.doesNotMatch(result.verdict, /looks fine/i);
});

test("an HTTP failure falls back instead of failing the turn", async () => {
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek" },
    {
      env: { AGENT_KIT_BUDGET_USD: "5", AGENT_KIT_MODEL_PRICES: PRICES, DEEPSEEK_API_KEY: "test-key" },
      fetch: fakeFetch({}, { ok: false, status: 503 }),
      spawnSync: codexOk,
    },
  );

  assert.equal(result.provider, "codex");
  assert.match(result.escalationReason, /HTTP 503/);
});

test("the unmetered provider has nowhere to escalate and reports plainly", async () => {
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "codex" },
    { env: {}, spawnSync: () => ({ error: new Error("codex not found") }) },
  );

  assert.equal(result.ok, false);
  assert.match(result.verdict, /WARN: tool-check unavailable: codex not found/);
  assert.equal(result.escalatedFrom, undefined);
});
