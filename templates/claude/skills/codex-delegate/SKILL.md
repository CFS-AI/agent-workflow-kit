---
name: codex-delegate
description: Delegate routine implementation/research/test work to Codex while the orchestrator keeps ownership through review-gate.
user-invocable: true
allowed-tools: Read, Bash, Write, Edit, Glob, Grep
---

# Codex Delegate

Use Codex for execution work after the orchestrator has defined scope and DoD.

## When to delegate

Good candidates:

- implementation from a clear plan;
- test generation or repair;
- codebase research;
- mechanical refactors;
- independent long-running work in a separate worktree.

Do not delegate:

- unclear tasks without DoD;
- final architecture decisions;
- secret handling;
- production deployments;
- work that needs full conversation context more than repository context.

## Task envelope

```text
TASK: <id>
TASK TYPE: bugfix|feature|refactor|research|docs|review|deploy
BASE SHA: <git rev-parse HEAD>
ALLOWED PATHS: <files/dirs Codex may touch>
RELEVANT MEMORY: <compact excerpt, no secrets>
DOD: <tests/oracles/expected behavior>
FORBIDDEN: do NOT git commit/push/rebase/reset; touch only ALLOWED PATHS; no dependency mass-upgrades.
REPORT BACK: files touched, tests run, result, risks, memory candidate.
```

## Modes

### MCP sync

Small/iterative work in the shared tree. Use workspace-write sandbox and `approval-policy: never`.

### CLI background

Independent/long work in a separate git worktree.

```bash
ROOT=$(git rev-parse --show-toplevel)
WT="$(dirname "$ROOT")/$(basename "$ROOT")-codex-<task>"
git worktree add "$WT" HEAD
scripts/dev/codex-exec.sh -C "$WT" -o /tmp/codex-<task>.out -s workspace-write '<task envelope + prompt>'
```

### Handoff

For large or risky work, write `dev/codex-tasks/TASK-<id>.md` and let a human run it in Codex.app.

## Review-gate

Codex never commits. The orchestrator must:

1. inspect diff;
2. verify allowed paths;
3. check DoD;
4. run tests/linters;
5. scrub secrets/private data;
6. commit only after acceptance.
