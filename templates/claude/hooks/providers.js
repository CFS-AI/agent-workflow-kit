#!/usr/bin/env node
"use strict";

/**
 * Provider layer for delegated review/planning calls.
 *
 * The kit was built around one transport: the Codex CLI on a subscription, where an
 * extra call costs nothing and the only failure mode is "binary missing". A paid
 * HTTP provider breaks both assumptions — every call costs money and can return
 * prose instead of a verdict — so the seam that used to be a single spawnSync is
 * now a provider with an explicit result contract.
 *
 * Default routing is unchanged: every profile stays on Codex until a provider is
 * named explicitly. Nothing here enables a paid route on its own.
 */

const { spawnSync } = require("child_process");

const DEFAULT_PROVIDER = "codex";

const PROVIDERS = {
  codex: {
    kind: "cli",
    // Subscription transport: spend is not per-call, so no budget ceiling applies.
    metered: false,
    defaultTimeoutSec: 25,
  },
  deepseek: {
    kind: "http",
    metered: true,
    endpoint: "https://api.deepseek.com/chat/completions",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultTimeoutSec: 60,
    // A route carries a Codex model name, which DeepSeek has never heard of. Every
    // paid provider therefore declares its own name per profile: deliberative
    // profiles get the reasoner, execution profiles the cheaper chat model.
    models: {
      prime: "deepseek-reasoner",
      plan: "deepseek-reasoner",
      review: "deepseek-reasoner",
      build: "deepseek-chat",
      simple: "deepseek-chat",
      default: "deepseek-chat",
    },
  },
};

/**
 * The one shape a verdict may take, used for both parsing and enforcement.
 *
 * Models answer in markdown — `**BLOCK**: …`, `- BLOCK — …`, `> WARN: …` — so
 * decoration and `:`/`-`/em-dash separators are all part of the verdict. Prose that
 * merely opens with the word ("Approve only if …") is not: the keyword has to be
 * followed by a separator or end the line.
 */
const VERDICT_RE = /^[\s>*_`#+-]*(APPROVE|WARN|BLOCK)[*_`]*\s*(?:[:—–-]\s*(.*))?$/i;

/** Heavier verdicts win over lighter ones no matter where in the response they appear. */
const VERDICT_SEVERITY = { APPROVE: 1, WARN: 2, BLOCK: 3 };

const DEFAULT_MAX_TOKENS = 512;

/** Cyrillic prompts and shell commands tokenize denser than English prose. */
const CHARS_PER_TOKEN = 2;

/**
 * Names an actual provider, as opposed to a property every object has.
 *
 * `AGENT_KIT_PROVIDER=constructor` used to pass the guard and reach the paid endpoint
 * with the API key, skipping the budget checks entirely.
 */
function knownProvider(name) {
  const key = typeof name === "string" ? name.trim() : "";
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? key : null;
}

/**
 * Which provider serves a profile.
 *
 * `AGENT_KIT_PROVIDER_<PROFILE>` wins over the blanket `AGENT_KIT_PROVIDER`, so a
 * single profile can be moved to a paid provider without moving the rest.
 */
function resolveProvider(profile, env = process.env) {
  const specific = env[`AGENT_KIT_PROVIDER_${String(profile).toUpperCase()}`];
  const name = specific || env.AGENT_KIT_PROVIDER || DEFAULT_PROVIDER;
  return knownProvider(name) || DEFAULT_PROVIDER;
}

/**
 * The model name this provider is actually sent.
 *
 * Routing produces Codex model names (`gpt-5.6-*`) and nothing else, so without this
 * mapping a paid provider is either priced under a name it does not recognise — the
 * price lookup fails and every call escalates back to Codex — or, worse, sent a
 * request body advertising a competitor's model.
 */
function resolveModel(providerName, route, profile) {
  const provider = PROVIDERS[knownProvider(providerName) || DEFAULT_PROVIDER];
  if (!provider.models) return route.model;
  const key = String(profile || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(provider.models, key)
    ? provider.models[key]
    : provider.models.default;
}

/**
 * Bound on response length.
 *
 * A typo used to become `NaN`, which `JSON.stringify` writes as `null` — the request
 * then carried no bound at all, and neither did the cost it could run up.
 */
function maxTokens(env = process.env) {
  const value = Number(env.AGENT_KIT_MAX_TOKENS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_TOKENS;
}

/**
 * Declared price per million tokens, as `{"<model>": {"in": 0.27, "out": 1.1}}`.
 *
 * Deliberately empty by default. A model absent from this table is treated as
 * *unpriced*, never as free — an unpriced paid model silently recorded at $0 is
 * exactly how a budget goes blind.
 */
function loadPrices(env = process.env) {
  try {
    return JSON.parse(env.AGENT_KIT_MODEL_PRICES || "{}");
  } catch {
    return {};
  }
}

/**
 * What a completed call cost, or `null` when that cannot be known.
 *
 * A `usage` block that carries no token counts is no usage at all — reading it as
 * zero tokens turns an unmeasured call into a free one.
 */
function estimateCostUsd(model, usage, prices) {
  const price = prices[model];
  if (!price || usage == null) return null;
  const inTok = Number(usage.prompt_tokens);
  const outTok = Number(usage.completion_tokens);
  if (!Number.isFinite(inTok) && !Number.isFinite(outTok)) return null;
  return (Math.max(Number.isFinite(inTok) ? inTok : 0, 0) / 1e6) * Number(price.in || 0)
    + (Math.max(Number.isFinite(outTok) ? outTok : 0, 0) / 1e6) * Number(price.out || 0);
}

/**
 * The most a call can cost, computed before it is made.
 *
 * The ceiling used to be a pre-call trigger rather than a limit: any spend below it
 * let the call through, so the call itself carried the total past the ceiling. The
 * prompt is known exactly and the response is capped by `max_tokens`, which is enough
 * to bound the call in advance.
 */
function projectedCostUsd(model, prompt, env = process.env, prices = loadPrices(env)) {
  const price = prices[model];
  if (!price) return null;
  const inTok = Math.ceil(String(prompt || "").length / CHARS_PER_TOKEN);
  return (inTok / 1e6) * Number(price.in || 0) + (maxTokens(env) / 1e6) * Number(price.out || 0);
}

/**
 * Can a metered call still be made?
 *
 * Returns a reason instead of `true` whenever the answer is anything but a plain
 * yes — including "the model has no declared price", where the honest state is
 * "unknown spend", not "within budget", and "this call would not fit under the
 * ceiling", which is what makes the ceiling a limit.
 */
function checkBudget(model, spentUsd, env = process.env, projectedUsd = 0) {
  const ceiling = Number(env.AGENT_KIT_BUDGET_USD || 0);
  if (!ceiling) {
    return { ok: false, reason: "budget ceiling not set (AGENT_KIT_BUDGET_USD)" };
  }
  if (!loadPrices(env)[model]) {
    return { ok: false, reason: `model ${model} has no declared price — spend would be unmeasurable` };
  }
  if (spentUsd >= ceiling) {
    return { ok: false, reason: `budget ceiling reached ($${spentUsd.toFixed(4)} of $${ceiling})` };
  }
  const worstCase = spentUsd + Number(projectedUsd || 0);
  if (worstCase > ceiling) {
    return {
      ok: false,
      reason: `budget ceiling would be exceeded (worst case $${worstCase.toFixed(4)} of $${ceiling})`,
    };
  }
  return { ok: true };
}

function runCodex(route, prompt, timeoutSec, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const bin = (deps.env || process.env).CODEX_COPILOT_BIN || "codex";
  const result = spawn(
    bin,
    [
      "-c", "mcp_servers={}",
      "-c", `model_reasoning_effort=${route.effort}`,
      "-m", route.model,
      "exec", "--sandbox", "read-only", prompt,
    ],
    { encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 1024 * 1024 },
  );
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) return { ok: false, reason: `exited with status ${result.status}` };
  const text = (result.stdout || result.stderr || "").trim();
  return { ok: true, text, usage: null };
}

async function runDeepSeek(model, prompt, timeoutSec, deps = {}) {
  const env = deps.env || process.env;
  const provider = PROVIDERS.deepseek;
  const key = env[provider.apiKeyEnv];
  if (!key) return { ok: false, reason: `${provider.apiKeyEnv} is not set` };

  const doFetch = deps.fetch || globalThis.fetch;
  if (!doFetch) return { ok: false, reason: "no fetch implementation available" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const response = await doFetch(provider.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens(env),
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const body = await response.json();
    const text = String(body?.choices?.[0]?.message?.content || "").trim();
    return { ok: true, text, usage: body?.usage || null };
  } catch (err) {
    return { ok: false, reason: `request failed: ${err && err.name === "AbortError" ? "timeout" : err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the verdict out of a provider response.
 *
 * A response that does not carry a verdict is a failed call, not a quiet APPROVE.
 * When it carries several, the heaviest one is the answer: taking the last one let a
 * trailing "Approve only if …" overrule an explicit BLOCK, on a gate that guards
 * `rm -rf`, force-push and `terraform apply`. The verdict is returned normalised, so
 * whatever markdown the model used cannot reach the caller's matching.
 */
function parseVerdict(text) {
  let best = null;
  for (const line of String(text || "").split("\n")) {
    const match = VERDICT_RE.exec(line.trim());
    if (!match) continue;
    const level = match[1].toUpperCase();
    if (!best || VERDICT_SEVERITY[level] > VERDICT_SEVERITY[best.level]) {
      best = { level, detail: (match[2] || "").trim() };
    }
  }
  if (!best) return { ok: false, reason: "response carried no APPROVE/WARN/BLOCK verdict" };
  return {
    ok: true,
    level: best.level,
    verdict: best.detail ? `${best.level}: ${best.detail}` : best.level,
  };
}

/**
 * Does this note deny the pending action?
 *
 * The parser accepted `BLOCK\b` while the enforcement path matched `^BLOCK:`, so
 * "BLOCK - reason" parsed as a verdict and then passed as a non-block. One decision,
 * one place, so the two cannot drift apart again.
 */
function isBlockingVerdict(text) {
  const parsed = parseVerdict(text);
  return parsed.ok && parsed.level === "BLOCK";
}

/**
 * Run one delegated call and return a verdict, or a WARN explaining why there is none.
 *
 * A metered provider that cannot run — no key, no ceiling, no declared price, budget
 * exhausted, bad response — escalates to the unmetered default rather than failing the
 * turn. Escalation is reported, never silent: the caller sees which provider answered.
 */
async function askProvider(kind, route, prompt, options = {}, deps = {}) {
  const env = deps.env || process.env;
  const providerName = knownProvider(options.provider) || resolveProvider(options.profile, env);
  const provider = PROVIDERS[providerName];
  const timeoutSec = options.timeoutSec || provider.defaultTimeoutSec;
  const model = resolveModel(providerName, route, options.profile);

  const escalate = async (reason, costUsd = 0) => {
    const fallback = await askProvider(kind, route, prompt, { ...options, provider: DEFAULT_PROVIDER }, deps);
    return { ...fallback, costUsd, escalatedFrom: providerName, escalationReason: reason };
  };

  if (provider.metered) {
    const projected = projectedCostUsd(model, prompt, env);
    const budget = checkBudget(model, Number(options.spentUsd || 0), env, projected || 0);
    if (!budget.ok) return escalate(budget.reason);
  }

  const raw = providerName === "codex"
    ? runCodex(route, prompt, timeoutSec, deps)
    : await runDeepSeek(model, prompt, timeoutSec, deps);

  if (!raw.ok) {
    if (providerName !== DEFAULT_PROVIDER) return escalate(raw.reason);
    return { ok: false, provider: providerName, verdict: `WARN: ${kind} unavailable: ${raw.reason}` };
  }

  let costUsd = 0;
  if (provider.metered) {
    const measured = estimateCostUsd(model, raw.usage, loadPrices(env));
    if (measured == null) {
      // An unmeasurable cost is UNKNOWN, never zero. The answer is unusable, and the
      // worst case bounded before the call is charged so the ceiling still moves —
      // otherwise a provider that omits `usage` buys unlimited calls for $0.
      return escalate(
        `${providerName} returned no usable usage — spend is unmeasurable`,
        projectedCostUsd(model, prompt, env) || 0,
      );
    }
    costUsd = measured;
  }

  const parsed = parseVerdict(raw.text);
  if (!parsed.ok) {
    return { ok: false, provider: providerName, costUsd, verdict: `WARN: ${kind} ${parsed.reason}` };
  }
  return { ok: true, provider: providerName, costUsd, level: parsed.level, verdict: parsed.verdict };
}

module.exports = {
  DEFAULT_PROVIDER,
  PROVIDERS,
  askProvider,
  checkBudget,
  estimateCostUsd,
  isBlockingVerdict,
  loadPrices,
  maxTokens,
  parseVerdict,
  projectedCostUsd,
  resolveModel,
  resolveProvider,
  runCodex,
  runDeepSeek,
};
