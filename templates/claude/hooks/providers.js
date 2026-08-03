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
 * An HTTP provider bills per call by definition, and every budget gate keys off
 * `metered`. A record that says otherwise would take the paid transport with none of the
 * checks, so the contradiction is refused at load time rather than discovered by a bill.
 */
function validateProviders(table) {
  for (const [name, provider] of Object.entries(table)) {
    if (provider.kind === "http" && !provider.metered) {
      throw new Error(`provider ${name} declares an HTTP transport without being metered`);
    }
  }
  return table;
}

validateProviders(PROVIDERS);

/**
 * The one shape a verdict may take, used for both parsing and enforcement.
 *
 * Models answer in markdown — `**BLOCK**: …`, `- BLOCK — …`, `> WARN: …` — and often
 * behind a label (`**Verdict:** APPROVE`), so decoration, a leading label and
 * `:`/`-`/em-dash separators are all part of the verdict. Prose that merely opens with
 * the word ("Approve only if …") is not: the keyword has to be followed by a separator
 * or end the line.
 */
/**
 * A denial is recognised in the shapes models actually write it; an approval is not.
 *
 * `BLOCKED:`, `**Blocked**`, `Verdict: BLOCKED`, `DENY:`, `REJECT:` were every one of
 * them read as "no verdict" while the exact token `BLOCK` was the only denial the gate
 * understood — on a gate whose whole job is to stop `rm -rf` and force-push. The
 * asymmetry is deliberate: reading more words as a denial costs a retry, reading more
 * words as an approval runs the command, so `APPROVE` and `WARN` stay exact.
 */
const DENIAL_TOKEN = "BLOCK(?:ED|ING|S)?|DENY|DENIED|DENIES|REJECT(?:ED|ING|S)?";

const VERDICT_RE = new RegExp(
  "^[\\s>*_`#+-]*(?:[*_`]*(?:verdict|вердикт)[*_`]*\\s*[:—–-][*_`\\s]*)?" +
    `[*_\`]*(APPROVE|WARN|${DENIAL_TOKEN})[*_\`]*\\s*(?:[:—–-]\\s*(.*))?$`,
  "i",
);

/**
 * A verdict still counts when something introduces it.
 *
 * Anchoring to the start of a line lost every denial a model wrote as a recommendation
 * or a numbered step — `Recommendation: **BLOCK**: destructive`, `1. BLOCK: rm -rf` —
 * on a gate that guards `rm -rf`, force-push and `terraform apply`. So a leading label
 * or list marker is stripped and the line is read again.
 */
const VERDICT_LEAD_RE = /^(?:\d+[.)]\s*|[^:\n]{1,40}:\s*)/;

/**
 * The word appearing somewhere in the prose, which is not the same as a verdict.
 *
 * Reading a bare mention as a denial looked safe — a false denial is only noise, a missed
 * one runs the command — until you count how models write: `APPROVE: no BLOCK condition
 * applies` denied itself, and a gate that fires on correct approvals is a gate that gets
 * turned off. Reading it as an approval is worse still. So a mention with no structural
 * verdict anywhere is neither: the response is ambiguous, which is a failed call, which
 * escalates for a second opinion. Ambiguity costs a retry, never a run.
 */
const BLOCK_MENTION_RE = new RegExp(`\\b(?:${DENIAL_TOKEN})\\b`, "i");

/** Heavier verdicts win over lighter ones no matter where in the response they appear. */
const VERDICT_SEVERITY = { APPROVE: 1, WARN: 2, BLOCK: 3 };

const DEFAULT_MAX_TOKENS = 512;

/** Statuses a vendor returns before any model runs: rejected at the door, never billed. */
const GATEWAY_REFUSALS = new Set([400, 401, 402, 403, 404, 429]);

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
    const parsed = JSON.parse(env.AGENT_KIT_MODEL_PRICES || "{}");
    // `null` is valid JSON, and it used to reach the lookup as a table: every price read
    // threw a TypeError and took the whole hook down with it, where a broken price table
    // has to mean "unpriced, refuse the call".
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A usable metered price has two finite, non-negative components and costs something.
 *
 * Treat malformed numbers as unknown. Coercing a negative or non-numeric price to
 * zero makes the budget gate permissive precisely when its accounting is unreliable.
 */
function priceFor(model, prices) {
  const raw = prices[model];
  if (!raw || typeof raw !== "object") return null;
  const input = Number(raw.in);
  const output = Number(raw.out);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0 || input + output <= 0) return null;
  return { in: input, out: output };
}

/**
 * Every credential this layer could be holding, so redaction can match values.
 *
 * Short values are skipped: a two-character "key" would redact half the message and tell
 * the operator nothing, and no real API key is that short.
 */
function secretValues(env) {
  const values = [];
  for (const provider of Object.values(PROVIDERS)) {
    if (!provider.apiKeyEnv) continue;
    const value = env[provider.apiKeyEnv];
    if (typeof value === "string" && value.trim().length >= 8) values.push(value.trim());
  }
  return values;
}

/**
 * Removes credentials before a transport error reaches hook output.
 *
 * Shape alone was not enough. `{"authorization":"Bearer sk-…"}` carries the key past a
 * `key: value` regex on the quotes, and `401 Unauthorized for key sk-…` carries it past
 * on the missing separator — both reached `additionalContext` intact. The key's own
 * value is the only reliable needle, so it is redacted first; the shape rules stay as a
 * second pass for credentials this layer never held and cannot look up.
 */
function safeReason(reason, env = process.env) {
  let text = String(reason || "unknown provider error");
  for (const secret of secretValues(env || {})) text = text.split(secret).join("<REDACTED>");
  return text
    .replace(/(authorization["'\s]*[:=]["'\s]*bearer\s+)[^\s,;"']+/gi, "$1<REDACTED>")
    .replace(/(api[_-]?key|password|secret|token)["'\s]*[:=]["'\s]*[^\s,;"']+/gi, "$1=<REDACTED>");
}

/**
 * What a completed call cost, or `null` when that cannot be known.
 *
 * A `usage` block that accounts for no tokens is no usage at all — reading it as zero
 * tokens turns an unmeasured call into a free one. Absent counts and a well-formed
 * block of zeros are the same claim, and OpenAI-compatible gateways make the second
 * one: no call that reached a model consumed nothing, so zero means unmeasured.
 */
function estimateCostUsd(model, usage, prices) {
  const price = priceFor(model, prices);
  if (!price || usage == null) return null;
  const inTok = Number(usage.prompt_tokens);
  const outTok = Number(usage.completion_tokens);
  const billedIn = Number.isFinite(inTok) && inTok > 0 ? inTok : 0;
  const billedOut = Number.isFinite(outTok) && outTok > 0 ? outTok : 0;
  if (billedIn + billedOut <= 0) return null;
  return (billedIn / 1e6) * Number(price.in || 0) + (billedOut / 1e6) * Number(price.out || 0);
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
  const price = priceFor(model, prices);
  if (!price) return null;
  // A byte is a conservative upper bound for BPE tokens (unlike a characters/token
  // heuristic, which underestimates dense code and non-ASCII text).
  const inTok = Buffer.byteLength(String(prompt || ""), "utf8");
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
  if (!priceFor(model, loadPrices(env))) {
    return { ok: false, reason: `model ${model} has no valid declared price — spend would be unmeasurable` };
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

/**
 * The HTTP transport, driven by the provider record it was dispatched for.
 *
 * It used to read `PROVIDERS.deepseek` directly while the caller dispatched on the
 * provider's *name*. The two agreed only because the table holds exactly one HTTP entry:
 * a second vendor would have been sent DeepSeek's endpoint and DeepSeek's key while its
 * own `metered` flag skipped every budget gate.
 *
 * `sent` says whether anything actually left the machine. A call that never reached the
 * network cannot be billed, and the reservation it holds has to come back.
 */
async function runHttpProvider(provider, model, prompt, timeoutSec, deps = {}) {
  const env = deps.env || process.env;
  const key = env[provider.apiKeyEnv];
  if (!key) return { ok: false, sent: false, reason: `${provider.apiKeyEnv} is not set` };

  const doFetch = deps.fetch || globalThis.fetch;
  if (!doFetch) return { ok: false, sent: false, reason: "no fetch implementation available" };

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
    // A refusal at the gateway is proof no model ran, so the reservation comes back.
    // Holding it turned a wrong or rotated key into the exact failure the reservation
    // release was written to prevent: the ledger walked to the ceiling one phantom
    // reservation per hook and switched the paid route off for good, having spent $0.
    // Anything else — 5xx, 408, an unknown status — may have been metered, so it holds.
    if (!response.ok) {
      return { ok: false, sent: !GATEWAY_REFUSALS.has(response.status), reason: `HTTP ${response.status}` };
    }
    const body = await response.json();
    const text = String(body?.choices?.[0]?.message?.content || "").trim();
    return { ok: true, text, usage: body?.usage || null };
  } catch (err) {
    // The request did leave, so `sent` stays true: a timeout or a socket error mid-flight
    // says nothing about whether the vendor is billing for it, and the reservation is
    // held rather than guessed away.
    return {
      ok: false,
      sent: true,
      reason: `request failed: ${err && err.name === "AbortError" ? "timeout" : safeReason(err && err.message, env)}`,
    };
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
  const body = String(text || "");
  const lines = body.split("\n").map((line) => line.trim());
  let best = null;
  for (const line of lines) {
    // Read the line, then read it again without whatever introduced it, so a verdict
    // behind `Recommendation:` or `1.` is found where anchoring alone would miss it.
    const match = VERDICT_RE.exec(line) || VERDICT_RE.exec(line.replace(VERDICT_LEAD_RE, ""));
    if (!match) continue;
    const token = match[1].toUpperCase();
    // Every denial word means the same thing downstream, so they all normalise to BLOCK.
    const level = token === "APPROVE" || token === "WARN" ? token : "BLOCK";
    if (!best || VERDICT_SEVERITY[level] > VERDICT_SEVERITY[best.level]) {
      best = { level, token, detail: (match[2] || "").trim() };
    }
  }
  if (!best && BLOCK_MENTION_RE.test(body)) {
    return { ok: false, reason: "response mentioned a denial without stating a verdict" };
  }
  if (!best) return { ok: false, reason: "response carried no APPROVE/WARN/BLOCK verdict" };
  // A carrier line that already opens with the word would otherwise read `BLOCK: BLOCKED …`.
  const detail = best.detail.replace(new RegExp(`^${best.token}\\b[\\s:—–-]*`, "i"), "").trim();
  return {
    ok: true,
    level: best.level,
    verdict: detail ? `${best.level}: ${detail}` : best.level,
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
  let reservedUsd = 0;
  let ceilingBreached = null;
  let originTransportFailed = false;

  /**
   * Hand the turn to the subscription provider, keeping any denial the first one made.
   *
   * A provider whose answer is unusable for billing still said something about safety.
   * Discarding an APPROVE that cannot be measured is the point of the rule; discarding a
   * BLOCK is a fail-open, and it was a reachable one — a paid reviewer that denied the
   * command while omitting `usage` had its denial replaced by the fallback's approval.
   * So the escalated result is the heavier of the two verdicts, never the lighter.
   */
  const escalate = async (reason, costUsd = 0, denialFromOrigin = null) => {
    const fallback = await askProvider(kind, route, prompt, { ...options, provider: DEFAULT_PROVIDER }, deps);
    const keepDenial = denialFromOrigin
      && (!fallback.ok || VERDICT_SEVERITY[fallback.level] < VERDICT_SEVERITY.BLOCK);
    return {
      ...fallback,
      ...(keepDenial ? { ok: true, level: "BLOCK", verdict: denialFromOrigin } : {}),
      costUsd,
      ...(reservedUsd > 0 ? { reservedUsd } : {}),
      ...(ceilingBreached ? { ceilingBreached } : {}),
      ...(originTransportFailed ? { originTransportFailed: providerName } : {}),
      escalatedFrom: providerName,
      escalationReason: reason,
    };
  };

  if (provider.metered) {
    if (typeof options.providerUnavailable === "function" && options.providerUnavailable(providerName)) {
      return escalate(`${providerName} transport is in a failed state; not retried`);
    }
    if (env.AGENT_KIT_ALLOW_EXTERNAL_PROMPTS !== "1") {
      return escalate("external prompt transfer is not acknowledged (set AGENT_KIT_ALLOW_EXTERNAL_PROMPTS=1)");
    }
    const projected = projectedCostUsd(model, prompt, env);
    const budget = checkBudget(model, Number(options.spentUsd || 0), env, projected || 0);
    if (!budget.ok) return escalate(budget.reason);
    if (typeof options.reserveSpend === "function") {
      const reservation = options.reserveSpend(projected, Number(env.AGENT_KIT_BUDGET_USD));
      if (!reservation || !reservation.ok) return escalate(reservation?.reason || "paid-call reservation failed");
      reservedUsd = Number(reservation.reservedUsd || projected);
    }
  }

  const raw = provider.kind === "http"
    ? await runHttpProvider(provider, model, prompt, timeoutSec, deps)
    : runCodex(route, prompt, timeoutSec, deps);

  if (!raw.ok) {
    // A call that never left the machine cannot be billed, so its reservation is released
    // here. Without this a typo in the key name walked the ledger to the ceiling one
    // phantom reservation per hook and switched the paid route off for good, having spent
    // nothing. Anything that did reach the network keeps the worst case, because we
    // cannot prove the vendor is not charging for it.
    if (raw.sent === false && reservedUsd > 0 && typeof options.settleSpend === "function") {
      options.settleSpend(reservedUsd, 0);
      reservedUsd = 0;
    }
    // The breaker exists to stop hammering a transport that is down. A successful
    // fallback used to erase that fact, so a dead paid provider was retried on every
    // hook forever; the failure is carried out under its own provider's name.
    originTransportFailed = true;
    if (providerName !== DEFAULT_PROVIDER) return escalate(raw.reason);
    return {
      ok: false,
      transportFailed: true,
      provider: providerName,
      verdict: `WARN: ${kind} unavailable: ${raw.reason}`,
    };
  }

  // Read the answer before the accounting does. What the reviewer said about the command
  // and what the call cost are separate facts, and only one of them is about safety.
  const parsed = parseVerdict(raw.text);
  const denial = parsed.ok && parsed.level === "BLOCK" ? parsed.verdict : null;

  let costUsd = 0;
  if (provider.metered) {
    const measured = estimateCostUsd(model, raw.usage, loadPrices(env));
    if (measured == null) {
      // An unmeasurable cost is UNKNOWN, never zero. The answer is unusable, and the
      // worst case bounded before the call is charged so the ceiling still moves —
      // otherwise a provider that omits `usage` buys unlimited calls for $0. A denial it
      // carried is kept even so: unmeasurable spend is a billing problem, not a reason to
      // let a command through that a reviewer refused.
      return escalate(
        `${providerName} returned no usable usage — spend is unmeasurable`,
        projectedCostUsd(model, prompt, env) || 0,
        denial,
      );
    }
    costUsd = measured;
    if (reservedUsd > 0 && typeof options.settleSpend === "function") {
      // Settlement reconciles a bound to a fact, and the fact can be larger: the
      // reservation covers `AGENT_KIT_MAX_TOKENS` of output, which is a request, not a
      // promise the vendor made. When a longer answer lands the total past the ceiling
      // the money is already spent, so it is recorded and reported rather than hidden —
      // the next call is refused by the ceiling it just crossed.
      const total = Number(options.settleSpend(reservedUsd, costUsd));
      const ceiling = Number(env.AGENT_KIT_BUDGET_USD || 0);
      if (Number.isFinite(total) && ceiling > 0 && total > ceiling) ceilingBreached = { total, ceiling };
    }
  }

  if (!parsed.ok) {
    // A response without a verdict is a failed call like any other, so it escalates to
    // the subscription provider instead of being handed back as a WARN nobody can act
    // on. The default provider has nowhere to escalate to and says so plainly.
    if (providerName !== DEFAULT_PROVIDER) return escalate(`${providerName} ${parsed.reason}`, costUsd);
    return {
      ok: false,
      provider: providerName,
      costUsd,
      ...(reservedUsd > 0 ? { reservedUsd } : {}),
      ...(ceilingBreached ? { ceilingBreached } : {}),
      verdict: `WARN: ${kind} ${parsed.reason}`,
    };
  }
  return {
    ok: true,
    provider: providerName,
    costUsd,
    ...(reservedUsd > 0 ? { reservedUsd } : {}),
    ...(ceilingBreached ? { ceilingBreached } : {}),
    level: parsed.level,
    verdict: parsed.verdict,
  };
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
  priceFor,
  projectedCostUsd,
  resolveModel,
  resolveProvider,
  runCodex,
  runHttpProvider,
  safeReason,
  validateProviders,
};
