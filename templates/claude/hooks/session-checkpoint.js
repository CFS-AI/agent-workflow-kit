#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const THRESHOLD = Number(process.env.AGENT_WORKFLOW_CHECKPOINT_TOOLS || 50);

function loadCache(cacheDir, sessionId) {
  const file = path.join(cacheDir, `checkpoint-${sessionId}.json`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { tool_call_count: 0, last_checkpoint_count: 0 }; }
}

function saveCache(cacheDir, sessionId, cache) {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `checkpoint-${sessionId}.json`), JSON.stringify(cache, null, 2));
}

function main(inputStr, cwd) {
  let input = {};
  try { input = JSON.parse(inputStr); } catch {}
  const sessionId = input.session_id || "default";
  const cacheDir = path.join(cwd, ".claude/cache");
  const cache = loadCache(cacheDir, sessionId);
  cache.tool_call_count = (cache.tool_call_count || 0) + 1;
  cache.last_checkpoint_count ||= 0;

  const shouldCheckpoint = cache.tool_call_count - cache.last_checkpoint_count >= THRESHOLD;
  if (shouldCheckpoint) cache.last_checkpoint_count = cache.tool_call_count;
  saveCache(cacheDir, sessionId, cache);

  if (!shouldCheckpoint) return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [
        "## [AUTO CHECKPOINT]",
        `${THRESHOLD}+ tool calls since last checkpoint. Before continuing, update dev/status.md and today's dev/daily/YYYY-MM-DD.md with progress, decisions and next steps.`,
      ].join("\n"),
    },
  };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(main(fs.readFileSync(0, "utf8"), process.cwd())));
}

module.exports = { main };
