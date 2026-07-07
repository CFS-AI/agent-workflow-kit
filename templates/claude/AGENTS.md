# Agent Guidelines

These instructions apply to coding agents in this repository.

## Working style

- Prefer the smallest scoped change that satisfies the request.
- Preserve unrelated user changes.
- For bugs, reproduce or bound the issue before patching when feasible.
- Verify behavior after edits with the narrowest meaningful command.
- Do not use destructive git commands, force pushes or `--no-verify` unless explicitly requested.

## State and memory

- `dev/status.md` is the durable current state.
- `dev/daily/YYYY-MM-DD.md` is the session ledger.
- `dev/codex-tasks/` stores task envelopes and handoffs.
- Treat old memory as advisory; current prompt, tests and repo docs win.

## Codex Delegate

- Use `.claude/skills/codex-delegate/SKILL.md` for delegated execution work.
- Delegated Codex never commits, pushes, rebases or resets.
- Include `TASK`, `TASK TYPE`, `BASE SHA`, `ALLOWED PATHS`, `RELEVANT MEMORY`, `DOD` and `FORBIDDEN` in task envelopes.
- The orchestrator accepts delegated work only through review-gate: diff vs plan, allowed paths, DoD, tests/linters and known risks.

## Security

- No credentials, tokens, cookies, private keys or session IDs in git.
- Do not paste raw private data into issues, PRs, reports or prompts when a synthetic example is enough.
- Before publishing/sharing, run `scripts/scrub-check.sh`.
