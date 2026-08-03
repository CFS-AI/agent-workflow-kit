#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { askProvider, safeReason } = require("./providers.js");
const {
  readSpentUsd,
  recordSpendUsd,
  reserveSpendUsd,
  settleReservedSpendUsd,
} = require("./ledger.js");

const PROFILES = {
  prime: { model: "gpt-5.6-sol", effort: "xhigh" },
  plan: { model: "gpt-5.6-terra", effort: "high" },
  review: { model: "gpt-5.6-terra", effort: "high" },
  build: { model: "gpt-5.6-luna", effort: "high" },
  simple: { model: "gpt-5.6-luna", effort: "medium" },
};
const CIRCUIT_WINDOW_MS = Number(process.env.CODEX_COPILOT_CIRCUIT_WINDOW_MS || 5 * 60 * 1000);
const CIRCUIT_FAILURES = Number(process.env.CODEX_COPILOT_CIRCUIT_FAILURES || 3);

function choosePlanningProfile(prompt) {
  return /(strategic|strategy|system architecture|course correction|стратег|смен[аы].*курс|архитектур.*систем)/i.test(prompt)
    ? "prime"
    : "plan";
}

function isCircuitOpen(state, now = Date.now()) {
  const failures = (state.failures || []).filter((ts) => now - ts <= CIRCUIT_WINDOW_MS);
  return failures.length >= CIRCUIT_FAILURES;
}

function readCircuit(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { failures: [] }; }
}

function writeCircuit(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {}
}

function addContext(eventName, message) {
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: message },
  }));
}

function shouldSuggestDelegation(prompt) {
  return /(implement|refactor|write tests?|fix bug|run tests?|делегируй|реализуй|напиши тест|почини|рефактор)/i.test(prompt);
}

function shouldReviewPrompt(prompt) {
  return /(architecture|migration|deploy|production|security|risk|архитектур|миграц|деплой|прод|безопасн|риск)/i.test(prompt);
}

function shouldReviewTool(tool, command) {
  return tool === "Bash" && /(rm\s+-rf|git\s+(reset\s+--hard|push\s+--force|clean\s+-fd)|sudo\s+|terraform\s+apply|npm\s+publish|curl\b.*\|\s*(bash|sh))/i.test(command);
}

/**
 * Ask the routed provider and return both the note to show and the decision to enforce.
 *
 * The two used to be one string. The hook composed `${verdict} [escalated from …]` for
 * display and then re-parsed that same string to decide whether to deny — and the
 * bracketed suffix broke the match, so an escalated `BLOCK` silently stopped denying
 * anything. The verdict is now decided once, on the provider's own answer, and the
 * display string is built afterwards from a decision that can no longer drift.
 */
async function askCodex(kind, prompt, profile = "review", timeout = 20, deps = {}) {
  const route = PROFILES[profile] || PROFILES.review;
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..", "..");
  const cacheDir = path.join(projectRoot, ".claude", "cache");
  const circuitFile = path.join(cacheDir, "codex-copilot-circuit.json");
  const ledgerFile = path.join(cacheDir, "provider-spend.jsonl");
  const circuit = readCircuit(circuitFile);
  const now = Date.now();
  circuit.failures = (circuit.failures || []).filter((ts) => now - ts <= CIRCUIT_WINDOW_MS);
  if (isCircuitOpen(circuit, now)) {
    return { note: `WARN: Codex ${kind} skipped; circuit is open after repeated failures.`, blocking: false };
  }

  const result = await askProvider(kind, route, prompt, {
    profile,
    timeoutSec: timeout,
    spentUsd: readSpentUsd(ledgerFile),
    reserveSpend: (usd, ceiling) => reserveSpendUsd(ledgerFile, usd, ceiling),
    settleSpend: (reservedUsd, actualUsd) => settleReservedSpendUsd(ledgerFile, reservedUsd, actualUsd),
  }, deps);

  // The breaker exists to stop hammering a transport that is down, so only a transport
  // that never answered counts against it. A reviewer that replied without a verdict is
  // alive; counting that as a failure let one chatty provider close the breaker for
  // every profile, including the ones still on the subscription.
  if (result.transportFailed) circuit.failures.push(now);
  else circuit.failures = [];
  writeCircuit(circuitFile, circuit);
  // Reserved paid spend is already in the shared ledger; unreserved fallback costs
  // are recorded here. This keeps concurrent hooks below one ceiling.
  if (result.costUsd && !result.reservedUsd) recordSpendUsd(ledgerFile, result.costUsd);

  const notes = [result.verdict];
  if (result.escalatedFrom) notes.push(`[escalated from ${result.escalatedFrom}: ${result.escalationReason}]`);
  if (result.ceilingBreached) {
    const { total, ceiling } = result.ceilingBreached;
    notes.push(`[budget ceiling crossed on settlement: $${total.toFixed(4)} of $${ceiling}]`);
  }
  return { note: notes.join(" "), blocking: result.ok === true && result.level === "BLOCK" };
}

async function main(input) {
  const eventName = input.hook_event_name || "Unknown";
  if (process.env.CODEX_COPILOT === "0") return null;
  const strict = process.env.CODEX_COPILOT_MODE === "strict";

  if (eventName === "UserPromptSubmit") {
    const prompt = String(input.user_prompt || "");
    const hints = ["Codex copilot protocol is active."];
    if (shouldSuggestDelegation(prompt)) hints.push("Execution work detected: consider codex-delegate; Codex edits, orchestrator review-gates and commits.");
    if (shouldReviewPrompt(prompt)) {
      const profile = choosePlanningProfile(prompt);
      const { note } = await askCodex("planning-check", `Review this prompt. Return one line APPROVE/WARN/BLOCK.\n\n${prompt}`, profile, 25);
      hints.push(`Codex ${profile} note: ${note}`);
    }
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: hints.join("\n") } };
  }

  if (eventName === "PreToolUse") {
    const tool = String(input.tool_name || "");
    const command = String((input.tool_input || {}).command || "");
    if (!shouldReviewTool(tool, command)) return null;
    const { note, blocking } = await askCodex("tool-check", `Review pending tool call. Return one line APPROVE/WARN/BLOCK.\nTool=${tool}\nCommand=${command}`, "review");
    return strict && blocking
      ? { decision: "deny", reason: note }
      : { hookSpecificOutput: { hookEventName: eventName, additionalContext: `Codex review note: ${note}` } };
  }

  if (eventName === "Stop") {
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: "Before stopping: mention dirty worktree status, tests run, and remaining risks if any." } };
  }
  return null;
}

if (require.main === module) {
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", async () => {
    let input = {};
    try { input = JSON.parse(raw || "{}"); } catch {}
    try {
      const output = await main(input);
      if (output) console.log(JSON.stringify(output));
    } catch (err) {
      // A hook that throws prints nothing, and printing nothing on PreToolUse silently
      // removes the review from a destructive command. Say what broke instead.
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: input.hook_event_name || "Unknown",
          additionalContext: `Codex copilot failed: ${safeReason(err && err.message)}`,
        },
      }));
    }
  });
}

module.exports = { PROFILES, askCodex, choosePlanningProfile, isCircuitOpen, main };
