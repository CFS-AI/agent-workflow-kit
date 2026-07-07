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

Use Codex for routine implementation, tests, refactors and codebase research after the orchestrator has defined the task envelope.

Codex never commits, pushes, rebases or resets. The orchestrator does review-gate and commits only after verification.

## 5. Daily/status memory

- `dev/status.md` — durable current state, newest block at top.
- `dev/daily/YYYY-MM-DD.md` — session ledger: TODO, Done, Tracks.
- `dev/codex-tasks/` — task envelopes and handoffs.

This is not a replacement for product docs. Promote repeated runbooks into docs or skills during weekly review.
