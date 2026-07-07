#!/usr/bin/env node
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}

const eventName = input.hook_event_name || "Unknown";
const enabled = process.env.CODEX_COPILOT !== "0";
const strict = process.env.CODEX_COPILOT_MODE === "strict";
const codexBin = process.env.CODEX_COPILOT_BIN || `${process.env.HOME || ""}/.local/bin/codex`;

if (!enabled) process.exit(0);

function addContext(message) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: message } }));
}

function askCodex(kind, prompt, timeout = 20, effort = "medium") {
  if (codexBin.includes("/") && !fs.existsSync(codexBin)) return `WARN: Codex binary not found; skipped ${kind}`;
  const result = spawnSync(codexBin, ["-c", "mcp_servers={}", "-c", `model_reasoning_effort=${effort}`, "-m", "gpt-5.5", "exec", "--sandbox", "read-only", prompt], {
    encoding: "utf8",
    timeout: timeout * 1000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) return `WARN: Codex ${kind} unavailable: ${result.error.message}`;
  return (result.stdout || result.stderr || "WARN: Codex returned empty output").trim().split("\n").slice(-1)[0];
}

function shouldSuggestDelegation(prompt) {
  return /(implement|refactor|write tests?|fix bug|run tests?|делегируй|реализуй|напиши тест|почини|рефактор)/i.test(prompt);
}

function shouldReviewPrompt(prompt) {
  return /(architecture|migration|deploy|production|security|risk|архитектур|миграц|деплой|прод|безопасн|риск)/i.test(prompt);
}

function shouldReviewTool(tool, command) {
  if (tool !== "Bash") return false;
  return /(rm\s+-rf|git\s+(reset\s+--hard|push\s+--force|clean\s+-fd)|sudo\s+|terraform\s+apply|npm\s+publish|curl\b.*\|\s*(bash|sh))/i.test(command);
}

if (eventName === "UserPromptSubmit") {
  const prompt = String(input.user_prompt || "");
  const hints = ["Codex copilot protocol is active."];
  if (shouldSuggestDelegation(prompt)) hints.push("Execution work detected: consider codex-delegate; Codex edits, orchestrator review-gates and commits.");
  if (shouldReviewPrompt(prompt)) hints.push(`Codex planning note: ${askCodex("planning-check", `Review this prompt. Return one line APPROVE/WARN/BLOCK.\n\n${prompt}`, 25, "high")}`);
  addContext(hints.join("\n"));
} else if (eventName === "PreToolUse") {
  const tool = String(input.tool_name || "");
  const command = String((input.tool_input || {}).command || "");
  if (!shouldReviewTool(tool, command)) process.exit(0);
  const note = askCodex("tool-check", `Review pending tool call. Return one line APPROVE/WARN/BLOCK.\nTool=${tool}\nCommand=${command}`, 20, "medium");
  if (strict && /^BLOCK:/i.test(note)) {
    console.log(JSON.stringify({ decision: "deny", reason: note }));
  } else {
    addContext(`Codex tool note: ${note}`);
  }
} else if (eventName === "Stop") {
  addContext("Before stopping: mention dirty worktree status, tests run, and remaining risks if any.");
}
