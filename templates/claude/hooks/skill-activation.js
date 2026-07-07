#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SKILLS_DIR = path.resolve(__dirname, "..", "skills");
const RULES_PATH = path.join(SKILLS_DIR, "skill-rules.json");
const MAX_SKILLS = 3;

function loadRules() {
  try { return JSON.parse(fs.readFileSync(RULES_PATH, "utf8")).rules || []; }
  catch { return []; }
}

function skillHint(skillName) {
  const skillPath = path.join(SKILLS_DIR, skillName, "SKILL.md");
  try {
    const content = fs.readFileSync(skillPath, "utf8");
    const match = /^description:\s*(.+)$/m.exec(content);
    return `- \`${skillName}\` — ${match ? match[1].trim().replace(/^['\"]|['\"]$/g, "") : "(no description)"}`;
  } catch { return null; }
}

function matchKeywords(prompt, keywords, min = 1) {
  const lower = prompt.toLowerCase();
  let count = 0;
  for (const kw of keywords || []) {
    if (lower.includes(String(kw).toLowerCase()) && ++count >= min) return true;
  }
  return false;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  const prompt = input.user_prompt || "";
  if (!prompt) return process.stdout.write(JSON.stringify({}));

  const matched = [];
  for (const rule of loadRules().sort((a, b) => (a.priority || 999) - (b.priority || 999))) {
    const triggers = rule.triggers || {};
    const ok = triggers.always_load || matchKeywords(prompt, triggers.keywords, triggers.min_keyword_matches || 1);
    if (!ok) continue;
    const hint = skillHint(rule.skill);
    if (hint) matched.push(hint);
    if (matched.length >= MAX_SKILLS) break;
  }

  if (!matched.length) return process.stdout.write(JSON.stringify({}));
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `## Skill hints\n${matched.join("\n")}\nLoad full skill content only when needed.`,
    },
  }));
}

main().catch(() => process.stdout.write(JSON.stringify({})));
