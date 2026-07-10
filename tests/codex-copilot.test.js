"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROFILES,
  choosePlanningProfile,
  isCircuitOpen,
} = require("../templates/claude/hooks/codex-copilot.js");

test("maps GPT-5.6 profiles by responsibility", () => {
  assert.deepEqual(PROFILES.prime, { model: "gpt-5.6-sol", effort: "xhigh" });
  assert.deepEqual(PROFILES.plan, { model: "gpt-5.6-terra", effort: "high" });
  assert.deepEqual(PROFILES.review, { model: "gpt-5.6-terra", effort: "high" });
  assert.deepEqual(PROFILES.build, { model: "gpt-5.6-luna", effort: "high" });
  assert.deepEqual(PROFILES.simple, { model: "gpt-5.6-luna", effort: "medium" });
});

test("escalates strategic prompts to Prime and normal planning to Plan", () => {
  assert.equal(choosePlanningProfile("Нужна стратегическая корректировка архитектуры"), "prime");
  assert.equal(choosePlanningProfile("Составь план миграции и укажи риски"), "plan");
});

test("opens the circuit only after repeated recent failures", () => {
  const now = 1_000_000;
  assert.equal(isCircuitOpen({ failures: [now - 1000, now - 2000, now - 3000] }, now), true);
  assert.equal(isCircuitOpen({ failures: [now - 1000, now - 400_000, now - 500_000] }, now), false);
});
