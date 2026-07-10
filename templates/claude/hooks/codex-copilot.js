#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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

function askCodex(kind, prompt, profile = "review", timeout = 20) {
  const route = PROFILES[profile] || PROFILES.review;
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..", "..");
  const circuitFile = path.join(projectRoot, ".claude", "cache", "codex-copilot-circuit.json");
  const circuit = readCircuit(circuitFile);
  const now = Date.now();
  circuit.failures = (circuit.failures || []).filter((ts) => now - ts <= CIRCUIT_WINDOW_MS);
  if (isCircuitOpen(circuit, now)) return `WARN: Codex ${kind} skipped; circuit is open after repeated failures.`;

  const codexBin = process.env.CODEX_COPILOT_BIN || "codex";
  const result = spawnSync(codexBin, [
    "-c", "mcp_servers={}",
    "-c", `model_reasoning_effort=${route.effort}`,
    "-m", route.model,
    "exec", "--sandbox", "read-only", prompt,
  ], { encoding: "utf8", timeout: timeout * 1000, maxBuffer: 1024 * 1024 });

  const succeeded = !result.error && result.status === 0;
  if (succeeded) circuit.failures = [];
  else circuit.failures.push(now);
  writeCircuit(circuitFile, circuit);

  if (result.error) return `WARN: Codex ${kind} unavailable: ${result.error.message}`;
  const output = (result.stdout || result.stderr || "WARN: Codex returned empty output").trim();
  return output.split("\n").slice(-1)[0];
}

function main(input) {
  const eventName = input.hook_event_name || "Unknown";
  if (process.env.CODEX_COPILOT === "0") return null;
  const strict = process.env.CODEX_COPILOT_MODE === "strict";

  if (eventName === "UserPromptSubmit") {
    const prompt = String(input.user_prompt || "");
    const hints = ["Codex copilot protocol is active."];
    if (shouldSuggestDelegation(prompt)) hints.push("Execution work detected: consider codex-delegate; Codex edits, orchestrator review-gates and commits.");
    if (shouldReviewPrompt(prompt)) {
      const profile = choosePlanningProfile(prompt);
      hints.push(`Codex ${profile} note: ${askCodex("planning-check", `Review this prompt. Return one line APPROVE/WARN/BLOCK.\n\n${prompt}`, profile, 25)}`);
    }
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: hints.join("\n") } };
  }

  if (eventName === "PreToolUse") {
    const tool = String(input.tool_name || "");
    const command = String((input.tool_input || {}).command || "");
    if (!shouldReviewTool(tool, command)) return null;
    const note = askCodex("tool-check", `Review pending tool call. Return one line APPROVE/WARN/BLOCK.\nTool=${tool}\nCommand=${command}`, "review");
    return strict && /^BLOCK:/i.test(note)
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
  process.stdin.on("end", () => {
    let input = {};
    try { input = JSON.parse(raw || "{}"); } catch {}
    const output = main(input);
    if (output) console.log(JSON.stringify(output));
  });
}

module.exports = { PROFILES, choosePlanningProfile, isCircuitOpen, main };
