# TODO: Project name — Agent Workspace

This repository uses Agent Workflow Kit.

## Repository role

TODO: Describe what this repo owns and what lives elsewhere.

Recommended split:

- product code lives in product repositories;
- operational notes live in `dev/`;
- reusable rules live in `.claude/`, `.scaffold/`, `AGENTS.md`;
- secrets live only in env/vault/local settings, never in git.

## Tool map

**Claude Code**

- orchestration, diagnosis, planning, review-gate;
- hooks in `.claude/hooks/`;
- skills in `.claude/skills/`.

**Scaffold**

- structured task lifecycle: clarification → diagnosis → plan → approval → implementation → synthesis;
- project facts in `.scaffold/context.md`;
- rules/constraints/done criteria in `.scaffold/`.

**Codex Delegate**

- routine execution after a task envelope exists;
- no commit/push/rebase/reset;
- orchestrator accepts through review-gate.

## Session workflow

1. Read `dev/status.md`.
2. Use `dev/daily/YYYY-MM-DD.md` as the session ledger.
3. Diagnose before planning.
4. Ask for approval before risky edits/deployments.
5. Delegate routine implementation when it saves time.
6. Verify with a concrete oracle.
7. Commit accepted changes; do not leave dirty worktrees silently.

## Confidentiality

Never commit secrets, credentials, raw customer data, payroll, private strategy or personal data. Run `scripts/scrub-check.sh` before publishing.
