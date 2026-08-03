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
  },
};

/** Verdict the hook can act on. Anything else is not a result. */
const VERDICT_RE = /^(APPROVE|WARN|BLOCK)\b/i;

/**
 * Which provider serves a profile.
 *
 * `AGENT_KIT_PROVIDER_<PROFILE>` wins over the blanket `AGENT_KIT_PROVIDER`, so a
 * single profile can be moved to a paid provider without moving the rest.
 */
function resolveProvider(profile, env = process.env) {
  const specific = env[`AGENT_KIT_PROVIDER_${String(profile).toUpperCase()}`];
  const name = (specific || env.AGENT_KIT_PROVIDER || DEFAULT_PROVIDER).trim();
  return PROVIDERS[name] ? name : DEFAULT_PROVIDER;
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

function estimateCostUsd(model, usage, prices) {
  const price = prices[model];
  if (!price || usage == null) return null;
  const inTok = Number(usage.prompt_tokens || 0);
  const outTok = Number(usage.completion_tokens || 0);
  return (inTok / 1e6) * Number(price.in || 0) + (outTok / 1e6) * Number(price.out || 0);
}

/**
 * Can a metered call still be made?
 *
 * Returns a reason instead of `true` whenever the answer is anything but a plain
 * yes — including "the model has no declared price", where the honest state is
 * "unknown spend", not "within budget".
 */
function checkBudget(model, spentUsd, env = process.env) {
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

async function runDeepSeek(route, prompt, timeoutSec, deps = {}) {
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
        model: route.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: Number(env.AGENT_KIT_MAX_TOKENS || 512),
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
 * The old code took the last line and passed whatever it found onward, so a model
 * that answered in prose produced a "review note" that looked like a result. A
 * response that does not carry a verdict is a failed call, not a quiet APPROVE.
 */
function parseVerdict(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (VERDICT_RE.test(lines[i])) return { ok: true, verdict: lines[i] };
  }
  return { ok: false, reason: "response carried no APPROVE/WARN/BLOCK verdict" };
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
  const providerName = options.provider || resolveProvider(options.profile, env);
  const provider = PROVIDERS[providerName];
  const timeoutSec = options.timeoutSec || provider.defaultTimeoutSec;

  if (provider.metered) {
    const budget = checkBudget(route.model, Number(options.spentUsd || 0), env);
    if (!budget.ok) {
      const fallback = await askProvider(kind, route, prompt, { ...options, provider: DEFAULT_PROVIDER }, deps);
      return { ...fallback, escalatedFrom: providerName, escalationReason: budget.reason };
    }
  }

  const raw = providerName === "codex"
    ? runCodex(route, prompt, timeoutSec, deps)
    : await runDeepSeek(route, prompt, timeoutSec, deps);

  if (!raw.ok) {
    if (providerName !== DEFAULT_PROVIDER) {
      const fallback = await askProvider(kind, route, prompt, { ...options, provider: DEFAULT_PROVIDER }, deps);
      return { ...fallback, escalatedFrom: providerName, escalationReason: raw.reason };
    }
    return { ok: false, provider: providerName, verdict: `WARN: ${kind} unavailable: ${raw.reason}` };
  }

  const parsed = parseVerdict(raw.text);
  const costUsd = provider.metered ? estimateCostUsd(route.model, raw.usage, loadPrices(env)) : 0;
  if (!parsed.ok) {
    return { ok: false, provider: providerName, costUsd, verdict: `WARN: ${kind} ${parsed.reason}` };
  }
  return { ok: true, provider: providerName, costUsd, verdict: parsed.verdict };
}

module.exports = {
  DEFAULT_PROVIDER,
  PROVIDERS,
  askProvider,
  checkBudget,
  estimateCostUsd,
  loadPrices,
  parseVerdict,
  resolveProvider,
  runCodex,
  runDeepSeek,
};
