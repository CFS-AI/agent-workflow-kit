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
  PROVIDERS,
  askProvider,
  checkBudget,
  estimateCostUsd,
  isBlockingVerdict,
  parseVerdict,
  projectedCostUsd,
  resolveModel,
  resolveProvider,
  runHttpProvider,
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

test("a paid route needs an explicit acknowledgement before prompt text can leave the machine", async () => {
  let called = false;
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "contains a repository path and an incident detail",
    { provider: "deepseek", profile: "review" },
    {
      env: PAID_ENV,
      spawnSync: codexOk,
      fetch: async () => { called = true; throw new Error("must not be called"); },
    },
  );

  assert.equal(called, false);
  assert.equal(result.provider, "codex");
  assert.equal(result.escalatedFrom, "deepseek");
  assert.match(result.escalationReason, /ALLOW_EXTERNAL_PROMPTS/);
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

test("a denial is read wherever it appears, not only where a line begins", () => {
  // Every one of these parsed as a non-block: the pattern was anchored to the start of a
  // line, so a denial written as a recommendation, as a list item, or behind a label was
  // invisible to the gate that guards `rm -rf`.
  assert.equal(parseVerdict("APPROVE: routine\nRecommendation: **BLOCK**: destructive").level, "BLOCK");
  assert.equal(parseVerdict("WARN: minor\n1. BLOCK: rm -rf on a live path").level, "BLOCK");
  assert.equal(parseVerdict("APPROVE — looks fine\nOn reflection I must say BLOCK").level, "BLOCK");
  assert.equal(isBlockingVerdict("APPROVE: routine\nRecommendation: **BLOCK**: destructive"), true);
  // The denial carries its own line as the reason, so the operator sees what denied it.
  assert.match(parseVerdict("APPROVE: routine\nRecommendation: **BLOCK**: destructive").verdict, /destructive/);
});

test("a labelled verdict is still a verdict", () => {
  // `**Verdict:** BLOCK` is how a reasoning model answers, and it used to parse as no
  // verdict at all — which on the paid path meant a failed call, and on Codex a WARN.
  assert.equal(parseVerdict("Verdict: BLOCK").level, "BLOCK");
  assert.equal(parseVerdict("**Verdict:** APPROVE").level, "APPROVE");
  assert.equal(parseVerdict("Вердикт: WARN — трогает прод").level, "WARN");
});

test("reading a denial out of prose never extends to reading an approval out of it", () => {
  // The asymmetry is the point. A denial invented from prose is noise; an approval
  // invented from prose is a destructive command running unreviewed.
  assert.equal(parseVerdict("I would approve this, it looks harmless enough.").ok, false);
  assert.equal(parseVerdict("There is nothing here to warn about.").ok, false);
  assert.equal(isBlockingVerdict("I would approve this, it looks harmless enough."), false);
  // And a sentence that merely mentions the word denies, because that way round is safe.
  assert.equal(isBlockingVerdict("This is not a BLOCK situation."), true);
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

test("malformed or negative prices cannot make a paid call look affordable", async () => {
  for (const prices of [
    '{"deepseek-reasoner":{"in":-1,"out":-1}}',
    '{"deepseek-reasoner":{"in":"not-a-number","out":2}}',
    '{"deepseek-reasoner":{"in":0,"out":0}}',
  ]) {
    let called = false;
    const result = await askProvider(
      "tool-check",
      ROUTE,
      "check this",
      { provider: "deepseek", profile: "review", spentUsd: 4.99 },
      {
        env: {
          ...PAID_ENV,
          AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1",
          AGENT_KIT_MODEL_PRICES: prices,
        },
        spawnSync: codexOk,
        fetch: async () => { called = true; throw new Error("must not be called"); },
      },
    );

    assert.equal(called, false);
    assert.equal(result.provider, "codex");
    assert.match(result.escalationReason, /valid declared price/);
  }
});

test("a metered call is refused without a ceiling, without a price, or once spent", () => {
  assert.match(checkBudget("deepseek-chat", 0, { AGENT_KIT_MODEL_PRICES: PRICES }).reason, /ceiling not set/);
  assert.match(checkBudget("deepseek-chat", 0, { AGENT_KIT_BUDGET_USD: "5" }).reason, /no valid declared price/);
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
    { env: { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" }, fetch },
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
      env: { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
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
      env: { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
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
      env: { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
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
      env: { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
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
    {
      env: {
        AGENT_KIT_BUDGET_USD: "5",
        AGENT_KIT_MODEL_PRICES: PRICES,
        AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1",
      },
      spawnSync: codexOk,
    },
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
      env: {
        AGENT_KIT_BUDGET_USD: "5",
        AGENT_KIT_MODEL_PRICES: PRICES,
        DEEPSEEK_API_KEY: "unused",
        AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1",
      },
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
      env: { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
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
      env: { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
      fetch: fakeFetch({
        choices: [{ message: { content: "Sure, that looks fine to me." } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
      spawnSync: codexOk,
    },
  );

  // A failed call escalates like every other failed call: the README promises the
  // subscription answers, and a WARN the caller cannot act on is not an answer.
  assert.equal(result.escalatedFrom, "deepseek");
  assert.match(result.escalationReason, /no APPROVE\/WARN\/BLOCK verdict/);
  assert.equal(result.provider, "codex");
  // The prose itself must not travel onward dressed as a verdict.
  assert.doesNotMatch(result.verdict, /looks fine/i);
  // What the unusable answer already cost is still charged.
  assert.ok(result.costUsd > 0);
});

test("a response without a verdict escalates rather than reporting an unusable WARN", async () => {
  // The unmetered provider has nowhere to escalate to, so there the WARN is the answer.
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "codex" },
    { env: {}, spawnSync: () => ({ status: 0, stdout: "I would probably not do that.", stderr: "" }) },
  );

  assert.equal(result.ok, false);
  assert.equal(result.escalatedFrom, undefined);
  assert.match(result.verdict, /^WARN: tool-check response carried no/);
});

test("an HTTP failure falls back instead of failing the turn", async () => {
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek", profile: "review" },
    {
      env: { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
      fetch: fakeFetch({}, { ok: false, status: 503 }),
      spawnSync: codexOk,
    },
  );

  assert.equal(result.provider, "codex");
  assert.match(result.escalationReason, /HTTP 503/);
});

test("transport errors are redacted before they reach the hook output", async () => {
  const header = ["author", "ization"].join("");
  const secret = ["definitely", "not", "for", "output"].join("-");
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    { provider: "deepseek", profile: "review" },
    {
      env: { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
      fetch: async () => { throw new Error(`${header}: Bearer ${secret}`); },
      spawnSync: codexOk,
    },
  );

  assert.equal(result.provider, "codex");
  assert.match(result.escalationReason, new RegExp(`${header}: Bearer <REDACTED>`, "i"));
  assert.doesNotMatch(result.escalationReason, new RegExp(secret));
});

test("the key is redacted by its value, not by the shape of the text around it", async () => {
  const secret = ["sk", "definitely", "not", "for", "output"].join("-");
  const shapes = [
    // Quotes carried the key past the `key: value` rules; so did a bare mention.
    (key) => `request failed, headers {"${["author", "ization"].join("")}":"Bearer ${key}"}`,
    (key) => `401 Unauthorized for key ${key}`,
    (key) => `connect ECONNREFUSED while sending ${key} upstream`,
  ];

  for (const shape of shapes) {
    const result = await askProvider(
      "tool-check",
      ROUTE,
      "check this",
      { provider: "deepseek", profile: "review" },
      {
        env: { ...PAID_ENV, DEEPSEEK_API_KEY: secret, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
        fetch: async () => { throw new Error(shape(secret)); },
        spawnSync: codexOk,
      },
    );

    assert.doesNotMatch(result.escalationReason, new RegExp(secret), `leaked via: ${shape("<key>")}`);
    assert.match(result.escalationReason, /<REDACTED>/);
  }
});

test("a price table that is valid JSON but not a table refuses instead of throwing", async () => {
  // `null` parses, and it used to reach the lookup as a table: the TypeError took the
  // whole hook down, which on PreToolUse removes the review from a destructive command.
  for (const table of ["null", "[1,2]", '"nope"', "0", "{oops"]) {
    let called = false;
    const result = await askProvider(
      "tool-check",
      ROUTE,
      "check this",
      { provider: "deepseek", profile: "review" },
      {
        env: { ...PAID_ENV, AGENT_KIT_MODEL_PRICES: table, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
        fetch: async () => { called = true; throw new Error("must not be called"); },
        spawnSync: codexOk,
      },
    );

    assert.equal(called, false, `${table} reached the paid transport`);
    assert.equal(result.provider, "codex");
    assert.match(result.escalationReason, /no valid declared price/);
  }
});

test("a call that never left the machine gives its reservation back", async () => {
  // A typo in the key name used to walk the ledger to the ceiling one phantom
  // reservation per hook and switch the paid route off for good, having spent nothing.
  const ledger = [];
  const env = { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" };
  delete env.DEEPSEEK_API_KEY;

  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    {
      provider: "deepseek",
      profile: "review",
      reserveSpend: (usd) => { ledger.push(usd); return { ok: true, reservedUsd: usd }; },
      settleSpend: (reserved, actual) => { ledger.push(actual - reserved); return ledger.reduce((a, b) => a + b, 0); },
    },
    { env, spawnSync: codexOk, fetch: async () => { throw new Error("must not be called"); } },
  );

  assert.equal(result.escalatedFrom, "deepseek");
  assert.match(result.escalationReason, /DEEPSEEK_API_KEY is not set/);
  assert.equal(ledger.reduce((a, b) => a + b, 0), 0);
  assert.equal(result.reservedUsd, undefined);
});

test("a request that did leave keeps its reservation, because the vendor may still bill it", async () => {
  const ledger = [];
  const result = await askProvider(
    "tool-check",
    ROUTE,
    "check this",
    {
      provider: "deepseek",
      profile: "review",
      reserveSpend: (usd) => { ledger.push(usd); return { ok: true, reservedUsd: usd }; },
      settleSpend: (reserved, actual) => { ledger.push(actual - reserved); return ledger.reduce((a, b) => a + b, 0); },
    },
    {
      env: { ...PAID_ENV, AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
      fetch: async () => { throw new Error("socket hang up"); },
      spawnSync: codexOk,
    },
  );

  assert.equal(result.escalatedFrom, "deepseek");
  assert.ok(ledger.reduce((a, b) => a + b, 0) > 0);
  assert.ok(result.reservedUsd > 0);
});

test("an HTTP provider is dispatched with its own record, not with the first one in the table", async () => {
  // The runner used to read `PROVIDERS.deepseek` while the caller dispatched on the
  // provider's name; a second vendor would have been handed DeepSeek's endpoint and key.
  const vendor = {
    kind: "http",
    metered: true,
    endpoint: "https://api.othervendor.example/v1/chat",
    apiKeyEnv: "OTHER_VENDOR_KEY",
    defaultTimeoutSec: 5,
    models: { default: "other-1" },
  };
  const seen = { url: null, auth: null };
  const result = await runHttpProvider(vendor, "other-1", "check this", 5, {
    env: { OTHER_VENDOR_KEY: "other-vendor-key" },
    fetch: async (url, init) => {
      seen.url = url;
      seen.auth = init.headers.authorization;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "APPROVE: fine" } }] }) };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(seen.url, vendor.endpoint);
  assert.equal(seen.auth, "Bearer other-vendor-key");
});

test("an HTTP provider that claims to be unmetered cannot exist", () => {
  // Every budget gate keys off `metered`, so an HTTP record without it would take the
  // paid transport with none of the checks. The table refuses to load instead.
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.kind === "http") assert.equal(provider.metered, true);
  }
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
