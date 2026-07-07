# Review-gate

Delegation is useful only if the orchestrator remains accountable.

## Required checks before accepting delegated work

1. Read the delegate report.
2. Inspect `git diff` yourself.
3. Check `ALLOWED PATHS`: no extra files, no drive-by refactors.
4. Check DoD item by item.
5. Run the narrowest meaningful tests/linters.
6. Verify no secrets or private data were added.
7. Commit only after the above pass.

## Reject or rework if

- the delegate changed files outside scope;
- the solution relies on unverifiable assumptions;
- tests are missing or fail;
- a production/deployment effect is claimed without a live oracle;
- the diff contains secrets or private data.

## Commit rule

Codex/delegated agents do not commit. The orchestrator commits after review-gate.
