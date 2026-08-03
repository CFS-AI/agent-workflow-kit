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
  isBlockingVerdict,
  parseVerdict,
  projectedCostUsd,
  resolveModel,
  resolveProvider,
} = require("../templates/claude/hooks/providers.js");

// Production routes carry Codex model names; nothing in the hook can produce a
// DeepSeek one, so the suite drives the layer with what it will really be handed.
const ROUTE = { model: "gpt-5.6-terra", effort: "high" };
const PRICES = JSON.stringify({
  "deepseek-chat": { in: 0.27, out: 1.1 },
  "deepseek-reasoner": { in: 0.55, out: 2.19 },
});
const PAID_ENV = {
  AGENT_KIT_BUDGET_USD: "5",
  AGENT_KIT_MODEL_PRICES: PRICES,
  DEEPSEEK_API_KEY: "test-key",
};

const codexOk = () => ({ status: 0, stdout: "APPROVE: nothing risky here", stderr: "" });

function fakeFetch(payload, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => payload });
}

function recordingFetch(payload) {
  const seen = { body: null };
  const fetch = async (_url, init) => {
    seen.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => payload };
  };
  return { seen, fetch };
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

test("a prototype property name is not a provider", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(resolveProvider("review", { AGENT_KIT_PROVIDER: name }), "codex");
    assert.equal(resolveProvider("review", { AGENT_KIT_PROVIDER_REVIEW: name }), "codex");
  }
});

test("a prototype property name cannot reach the paid transport either", async () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    let called = false;
    const result = await askProvider(
      "tool-check",
      ROUTE,
      "check this",
      { provider: name, profile: "review" },
      {
        env: PAID_ENV,
        spawnSync: codexOk,
        fetch: async () => { called = true; throw new Error("must not be called"); },
      },
    );

    // Escalation swallows a throwing transport, so landing on Codex proves nothing on
    // its own: the API key must never have left, which only the counter can say.
    assert.equal(called, false, `${name} reached the paid transport`);
    assert.equal(result.provider, "codex");
    assert.equal(result.ok, true);
    assert.equal(result.escalatedFrom, undefined);
  }
});

test("prose is not a verdict", () => {
  assert.deepEqual(parseVerdict("BLOCK: force push to main"), {
    ok: true,
    level: "BLOCK",
    verdict: "BLOCK: force push to main",
  });
  assert.equal(parseVerdict("Looks reasonable to me, I would go ahead.").ok, false);
  assert.equal(parseVerdict("").ok, false);
});

test("a verdict is found past the reasoning that precedes it", () => {
  const parsed = parseVerdict("Some reasoning first.\nWARN: touches production config");
  assert.equal(parsed.verdict, "WARN: touches production config");
});

test("the heaviest verdict wins, whatever order the model wrote them in", () => {
  assert.equal(parseVerdict("BLOCK: force push to main\nWARN: also rewrites tags").level, "BLOCK");
  assert.equal(parseVerdict("WARN: noisy\nBLOCK: destroys uncommitted work").level, "BLOCK");
  assert.equal(parseVerdict("APPROVE: fine\nWARN: but check the path").level, "WARN");
});

test("prose that opens with a verdict word never outranks an explicit BLOCK", () => {
  const parsed = parseVerdict("BLOCK: rm -rf on a shared path\nApprove only if the path is scoped.");
  assert.equal(parsed.level, "BLOCK");
  // On its own that sentence is reasoning, not a result.
  assert.equal(parseVerdict("Approve only if the path is scoped.").ok, false);
});

test("markdown decoration is how models actually answer, and it is still a verdict", () => {
  assert.equal(parseVerdict("**BLOCK**: force push to main").level, "BLOCK");
  assert.equal(parseVerdict("- BLOCK: force push to main").level, "BLOCK");
  assert.equal(parseVerdict("> **WARN** — touches production config").level, "WARN");
  assert.equal(parseVerdict("`APPROVE`").level, "APPROVE");
});

test("parsing and enforcement agree on what counts as a block", () => {
  // The parser accepted `BLOCK\b` while the hook enforced `^BLOCK:`, so a verdict
  // separated by a dash parsed fine and then slipped through as a non-block.
  assert.equal(isBlockingVerdict("BLOCK - reason"), true);
  assert.equal(isBlockingVerdict("**BLOCK**: reason"), true);
  assert.equal(isBlockingVerdict("BLOCK"), true);
  assert.equal(isBlockingVerdict("APPROVE: nothing risky here"), false);
  assert.equal(isBlockingVerdict("Approve only if the path is scoped."), false);
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

test("the ceiling is a limit, not a trigger", () => {
  const env = { AGENT_KIT_BUDGET_USD: "5", AGENT_KIT_MODEL_PRICES: PRICES, AGENT_KIT_MAX_TOKENS: "512" };
  const worst = projectedCostUsd("deepseek-reasoner", "x".repeat(4000), env);
  assert.ok(worst > 0);
  assert.equal(checkBudget("deepseek-reasoner", 4, env, worst).ok, true);
  // Room left under the ceiling, but not enough room for this call.
  assert.match(
    checkBudget("deepseek-reasoner", 5 - worst / 2, env, worst).reason,
    /would be exceeded/,
  );
});

test("a typo in the token bound falls back to the default instead of unbounding it", () => {
  const good = projectedCostUsd("deepseek-chat", "", { AGENT_KIT_MODEL_PRICES: PRICES, AGENT_KIT_MAX_TOKENS: "512" });
  const typo = projectedCostUsd("deepseek-chat", "", { AGENT_KIT_MODEL_PRICES: PRICES, AGENT_KIT_MAX_TOKENS: "512x" });
  assert.ok(Number.isFinite(typo));
  assert.equal(typo, good);
});

test("a profile routed to a paid provider gets that provider's own model name", () => {
  assert.equal(resolveModel("deepseek", ROUTE, "review"), "deepseek-reasoner");
  assert.equal(resolveModel("deepseek", ROUTE, "simple"), "deepseek-chat");
  assert.equal(resolveModel("deepseek", ROUTE, "unknown-profile"), "deepseek-chat");
  assert.equal(resolveModel("codex", ROUTE, "review"), "gpt-5.6-terra");
});

test("the request body carries the provider's model, never the Codex route name", async () => {
  const { seen, fetch } = recordingFetch({
    choices: [{ message: { content: "APPROVE: plan is bounded" } }],
    usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
  });
  const result = await askProvider(
    "planning-check",
    ROUTE,
    "review this plan",
    { provider: "deepseek", profile: "review" },
    { env: PAID_ENV, fetch },
  );

  assert.equal(seen.body.model, "deepseek-reasoner");
  assert.doesNotMatch(seen.body.model, /gpt-5\.6/);
  assert.equal(result.ok, true);
  assert.equal(result.provider, "deepseek");
  assert.equal(result.costUsd, 0.55);
});

test("a response without usage is a failed metered call, never a free one", async () => {
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek", profile: "review" },
    {
      env: PAID_ENV,
      fetch: fakeFetch({ choices: [{ message: { content: "APPROVE: nothing risky" } }] }),
      spawnSync: codexOk,
    },
  );

  assert.equal(result.escalatedFrom, "deepseek");
  assert.match(result.escalationReason, /unmeasurable/i);
  // Unknown spend is charged at the bound we set before the call, so the ceiling moves.
  assert.ok(result.costUsd > 0);
});

test("an empty usage block is no usage at all", async () => {
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek", profile: "review" },
    {
      env: PAID_ENV,
      fetch: fakeFetch({ choices: [{ message: { content: "APPROVE: fine" } }], usage: {} }),
      spawnSync: codexOk,
    },
  );

  assert.equal(result.escalatedFrom, "deepseek");
  assert.ok(result.costUsd > 0);
});

test("a usage block that accounts for no tokens is no usage at all", async () => {
  // OpenAI-compatible gateways answer with a well-formed usage block full of zeros.
  // No real call costs nothing, so zeros are an unmeasured call, not a free one.
  assert.equal(
    estimateCostUsd("deepseek-chat", { prompt_tokens: 0, completion_tokens: 0 }, JSON.parse(PRICES)),
    null,
  );
  // `1e999` parses out of a JSON body as Infinity, and an infinite cost is one the
  // ledger drops as unrecordable — which is the $0 call again, wearing a big number.
  assert.equal(
    estimateCostUsd("deepseek-chat", { prompt_tokens: 1e999, completion_tokens: 0 }, JSON.parse(PRICES)),
    null,
  );

  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek", profile: "review" },
    {
      env: PAID_ENV,
      fetch: fakeFetch({
        choices: [{ message: { content: "APPROVE: fine" } }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
      spawnSync: codexOk,
    },
  );

  assert.equal(result.escalatedFrom, "deepseek");
  assert.match(result.escalationReason, /unmeasurable/i);
  assert.ok(result.costUsd > 0);
});

test("a budget with less room than the call needs refuses before spending it", async () => {
  let called = false;
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek", profile: "review", spentUsd: 4.9999 },
    {
      env: PAID_ENV,
      spawnSync: codexOk,
      fetch: async () => { called = true; throw new Error("must not be called"); },
    },
  );

  assert.equal(called, false);
  assert.equal(result.escalatedFrom, "deepseek");
  assert.match(result.escalationReason, /would be exceeded/);
});

test("a missing key escalates to the unmetered provider and says so", async () => {
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek", profile: "review" },
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
    { provider: "deepseek", profile: "review", spentUsd: 99 },
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
    { provider: "deepseek", profile: "simple" },
    {
      env: PAID_ENV,
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
    { provider: "deepseek", profile: "review" },
    {
      env: PAID_ENV,
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
    { provider: "deepseek", profile: "review" },
    {
      env: PAID_ENV,
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
