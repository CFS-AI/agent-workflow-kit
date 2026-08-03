"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  PROFILES,
  askCodex,
  choosePlanningProfile,
  isCircuitOpen,
  main,
} = require("../templates/claude/hooks/codex-copilot.js");
const { readSpentUsd } = require("../templates/claude/hooks/ledger.js");

const PAID_ENV = {
  AGENT_KIT_PROVIDER: "deepseek",
  AGENT_KIT_BUDGET_USD: "5",
  AGENT_KIT_MODEL_PRICES: '{"deepseek-reasoner":{"in":0.55,"out":2.19}}',
  DEEPSEEK_API_KEY: "test-key",
  AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1",
};

function withProjectRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kit-hook-"));
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  return Promise.resolve(fn(path.join(root, ".claude", "cache", "provider-spend.jsonl")))
    .finally(() => {
      if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previous;
    });
}

// main() takes no injected transport, so the reviewer is stubbed where the hook looks
// for it: the Codex binary itself. That also covers the wiring between the two.
function withStubbedCodex(verdict, mode, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kit-bin-"));
  const bin = path.join(dir, "codex-stub");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(verdict)}\n`);
  fs.chmodSync(bin, 0o755);
  const previous = { bin: process.env.CODEX_COPILOT_BIN, mode: process.env.CODEX_COPILOT_MODE };
  process.env.CODEX_COPILOT_BIN = bin;
  process.env.CODEX_COPILOT_MODE = mode;
  const restore = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  return Promise.resolve(fn()).finally(() => {
    restore("CODEX_COPILOT_BIN", previous.bin);
    restore("CODEX_COPILOT_MODE", previous.mode);
  });
}

const RISKY_CALL = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /var/tmp/agent-kit-not-real" },
};

test("strict mode denies the tool call on a verdict of BLOCK", async () => {
  // A detail-less `BLOCK` is what a model returns when asked for one line, and it is
  // the shape that used to slip past enforcement while parsing accepted it.
  await withProjectRoot(() => withStubbedCodex("BLOCK", "strict", async () => {
    const output = await main(RISKY_CALL);
    assert.equal(output.decision, "deny");
    assert.match(output.reason, /BLOCK/);
  }));

  await withProjectRoot(() => withStubbedCodex("**BLOCK** — force push to main", "strict", async () => {
    const output = await main(RISKY_CALL);
    assert.equal(output.decision, "deny");
  }));
});

test("strict mode still denies once the verdict has been escalated", async () => {
  // The hook composed `BLOCK [escalated from deepseek: …]` for display and then re-parsed
  // that same string to decide. The bracketed suffix broke the match, so every escalated
  // denial stopped denying — and a misconfigured paid provider escalates on every call.
  await withProjectRoot(async () => {
    const { note, blocking } = await askCodex("tool-check", "rm -rf /srv", "review", 20, {
      // No ceiling, so the paid provider is refused before any request and escalates.
      env: { AGENT_KIT_PROVIDER_REVIEW: "deepseek", AGENT_KIT_ALLOW_EXTERNAL_PROMPTS: "1" },
      // A bare `BLOCK` is what a model returns when asked for one line, and it is the
      // shape the bracketed suffix used to hide.
      spawnSync: () => ({ status: 0, stdout: "BLOCK", stderr: "" }),
    });

    assert.match(note, /escalated from deepseek/);
    assert.equal(blocking, true);
  });
});

test("strict mode is not a blanket deny", async () => {
  await withProjectRoot(() => withStubbedCodex("APPROVE: scoped to a temp path", "strict", async () => {
    const output = await main(RISKY_CALL);
    assert.equal(output.decision, undefined);
    assert.match(output.hookSpecificOutput.additionalContext, /APPROVE/);
  }));
});

test("outside strict mode a BLOCK advises instead of denying", async () => {
  await withProjectRoot(() => withStubbedCodex("BLOCK", "advisory", async () => {
    const output = await main(RISKY_CALL);
    assert.equal(output.decision, undefined);
    assert.match(output.hookSpecificOutput.additionalContext, /BLOCK/);
  }));
});

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

test("what a metered call cost lands in the spend ledger", async () => {
  await withProjectRoot(async (ledgerFile) => {
    const note = await askCodex("tool-check", "check this", "review", 20, {
      env: PAID_ENV,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "APPROVE: nothing risky here" } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
        }),
      }),
    });

    assert.deepEqual(note, { note: "APPROVE: nothing risky here", blocking: false });
    assert.equal(readSpentUsd(ledgerFile).toFixed(2), "0.55");
  });
});

test("the ledger stops the routine before the ceiling is crossed, not after", async () => {
  await withProjectRoot(async (ledgerFile) => {
    let calls = 0;
    const deps = {
      // A million-token cap at $2.19/M is $2.19 of exposure per call.
      env: { ...PAID_ENV, AGENT_KIT_MAX_TOKENS: "1000000" },
      spawnSync: () => ({ status: 0, stdout: "APPROVE: codex answered", stderr: "" }),
      fetch: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "APPROVE: nothing risky here" } }],
            usage: { prompt_tokens: 0, completion_tokens: 1_000_000 },
          }),
        };
      },
    };

    for (let i = 0; i < 5; i += 1) await askCodex("tool-check", "check this", "review", 20, deps);

    // Two calls fit under $5; a third would land at $6.57, so it is never made.
    assert.equal(calls, 2);
    assert.equal(readSpentUsd(ledgerFile).toFixed(2), "4.38");
    assert.ok(readSpentUsd(ledgerFile) <= 5);
  });
});

test("a chatty paid provider does not close the breaker on the subscription reviewer", async () => {
  // The breaker counts transport failures. Counting "answered without a verdict" too let
  // one talkative vendor on one profile disable review for every profile for five
  // minutes — including the profiles still on Codex.
  await withProjectRoot(async () => {
    const deps = {
      env: PAID_ENV,
      spawnSync: () => ({ status: 0, stdout: "BLOCK: destroys uncommitted work", stderr: "" }),
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Sure, that seems okay." } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      }),
    };

    for (let i = 0; i < 4; i += 1) await askCodex("tool-check", "check this", "review", 20, deps);

    // The fifth call still reaches a reviewer rather than a skipped-circuit notice.
    const { note, blocking } = await askCodex("tool-check", "check this", "review", 20, deps);
    assert.doesNotMatch(note, /circuit is open/);
    assert.equal(blocking, true);
  });
});

test("a settlement that crosses the ceiling is reported, not swallowed", async () => {
  // The reservation bounds output at AGENT_KIT_MAX_TOKENS, which is a request, not a
  // promise. A longer answer is already paid for by the time it lands, so it is said out
  // loud instead of quietly appended.
  await withProjectRoot(async (ledgerFile) => {
    const { note } = await askCodex("tool-check", "check this", "review", 20, {
      env: { ...PAID_ENV, AGENT_KIT_BUDGET_USD: "0.002", AGENT_KIT_MAX_TOKENS: "512" },
      spawnSync: () => ({ status: 0, stdout: "APPROVE: codex answered", stderr: "" }),
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "APPROVE: fine" } }],
          usage: { prompt_tokens: 0, completion_tokens: 6000 },
        }),
      }),
    });

    assert.match(note, /budget ceiling crossed on settlement/);
    assert.ok(readSpentUsd(ledgerFile) > 0.002);
  });
});

test("a provider that reports zero tokens cannot buy unlimited calls for $0", async () => {
  await withProjectRoot(async (ledgerFile) => {
    let calls = 0;
    const deps = {
      env: { ...PAID_ENV, AGENT_KIT_MAX_TOKENS: "1000000" },
      spawnSync: () => ({ status: 0, stdout: "APPROVE: codex answered", stderr: "" }),
      fetch: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "APPROVE: fine" } }],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }),
        };
      },
    };

    for (let i = 0; i < 6; i += 1) await askCodex("tool-check", "check this", "review", 20, deps);

    assert.equal(calls, 2);
    assert.ok(readSpentUsd(ledgerFile) > 0);
  });
});

test("a provider that omits usage cannot buy unlimited calls for $0", async () => {
  await withProjectRoot(async (ledgerFile) => {
    let calls = 0;
    const deps = {
      env: { ...PAID_ENV, AGENT_KIT_MAX_TOKENS: "1000000" },
      spawnSync: () => ({ status: 0, stdout: "APPROVE: codex answered", stderr: "" }),
      fetch: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "APPROVE: fine" } }] }),
        };
      },
    };

    for (let i = 0; i < 6; i += 1) await askCodex("tool-check", "check this", "review", 20, deps);

    assert.equal(calls, 2);
    assert.ok(readSpentUsd(ledgerFile) > 0);
  });
});
