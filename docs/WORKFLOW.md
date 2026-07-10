# Workflow

This kit turns an AI coding workspace into a repeatable operating loop.

## 1. Session lifecycle

1. Read `dev/status.md` before acting.
2. Create/update `dev/daily/YYYY-MM-DD.md` for the current session.
3. Classify the task: read-only, diagnosis, implementation, deployment, incident, docs.
4. Diagnose with direct evidence before planning.
5. Show a short plan and wait for explicit approval when edits/deployments are involved.
6. Implement in the smallest safe scope.
7. Verify with a concrete oracle: test, health check, UI observation, or state diff.
8. Commit your own accepted changes; do not leave a dirty tree silently.

## 2. Claude Code surface

Claude Code owns orchestration:

- reads status/daily context;
- activates skills with hints, not full prompt injection;
- consults Codex for high-risk plans and tool calls;
- tracks long sessions with checkpoint reminders;
- accepts delegated work through review-gate.

## 3. Scaffold surface

Scaffold/prime is best for structured tasks:

```text
clarification → diagnosis → plan → approval → implementation → synthesis
```

Keep `.scaffold/context.md`, `.scaffold/rules.md`, `.scaffold/constraints.md` and `.scaffold/done-criteria.md` generic and factual.

## 4. Codex Delegate surface

Use Codex for routine implementation, tests, refactors and codebase research after the orchestrator has defined the task envelope. Profile by responsibility: Prime = Sol/xhigh, Plan/Review = Terra/high, Build = Luna/high, Simple = Luna/medium; Develop is Plan → Build → Review.

Codex never commits, pushes, rebases or resets. The orchestrator does review-gate and commits only after verification.

## 5. Daily/status memory

- `dev/status.md` — durable current state, newest block at top.
- `dev/daily/YYYY-MM-DD.md` — session ledger: TODO, Done, Tracks.
- `dev/codex-tasks/` — task envelopes and handoffs.

This is not a replacement for product docs. Promote repeated runbooks into docs or skills during weekly review.

## 6. Autonomy ladder

Use the smallest loop that gives the needed autonomy:

| Level | What the agent owns | Required stop condition |
|---|---|---|
| Turn | Verification of one task | Evidence or blocker |
| Goal | Whether DoD is reached | Independent evaluator, attempt/no-progress cap |
| Time | Trigger on a schedule | Idempotency key and concurrency cap |
| Proactive | Trigger and prompt | Kill switch, bounded pilot, independent review |

No loop may write outside its scope, continue after repeated identical failures or claim completion without its evidence oracle.

## 7. Optional CFS pack

The CFS pack adds two reusable operational loops:

### cfs-hub loop

```text
hub_status → diff against last infra check → hub_target(new CRIT) → classify next action
```

Key semantic: `UNKNOWN` is a missing-signal/config state, not proof of downtime.

### CFS Docs loop

```text
docs-intel search_docs/get_doc before work → update docs after behavior/deploy/runbook changes
```

The pack excludes personal `/eod` and private daily/status content. It carries only shareable workflow patterns and placeholder MCP config.
