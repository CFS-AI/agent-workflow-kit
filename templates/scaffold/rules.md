# Project rules

## Work loop

1. Clarify goal, scope and verification.
2. Diagnose before planning.
3. Present a short plan for risky or mutating work.
4. Wait for explicit approval when required.
5. Implement narrowly.
6. Verify with a concrete oracle.
7. Commit accepted changes.

## Delegation

- Use Codex Delegate for routine implementation, tests and research.
- Delegated agents do not commit/push/rebase/reset.
- Accept only through review-gate.

## State

- `dev/status.md` is the durable current state.
- `dev/daily/YYYY-MM-DD.md` is the session ledger.
- `dev/codex-tasks/` stores task envelopes and handoffs.

## Confidentiality

- No secrets in markdown, JSON, logs or PR bodies.
- Use synthetic examples instead of raw private data.
- Run scrub-check before sharing.
