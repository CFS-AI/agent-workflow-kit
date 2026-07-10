---
name: codex-delegate
description: Delegate strategy, planning, review, implementation, research, tests, and refactoring to Codex using GPT-5.6 role profiles. Use for a second opinion, strategic correction, implementation by plan, code review, or parallel/background work. Separates cognitive profiles from MCP, CLI worktree, and Codex.app transports; includes task envelope, escalation rules, and review-gate.
allowed-tools: Read, Bash, Write, Edit, Glob, Grep
---

# Codex Delegate

Delegate work to Codex while the orchestrator owns scope, review-gate and commit. Choose a cognitive profile first, then a transport. Do not confuse the model role with the execution transport.

## Preflight

1. Verify `codex --version`. If it is unavailable, stop and provide the Codex CLI installation blocker.
2. Never request, copy or place credentials in prompts; the account owner performs `codex login` themselves.
3. Use `scripts/dev/setup-codex-mcp.sh --check` before MCP sync. If MCP is unavailable, use CLI background or Codex.app hand-off.
4. If the selected GPT-5.6 model is unavailable, report a blocker rather than silently substituting another model.

## GPT-5.6 profiles

| Profile | Model / effort | Access | Use |
|---|---|---|---|
| Prime | `gpt-5.6-sol` / `xhigh` | read-only | strategy, system architecture, conflicting constraints |
| Plan | `gpt-5.6-terra` / `high` | read-only | research, micro-spec, DoD, risks and allowed paths |
| Review | `gpt-5.6-terra` / `high` | read-only | independent plan/diff/security/result review |
| Build | `gpt-5.6-luna` / `high` | workspace-write | important implementation from an accepted plan |
| Simple | `gpt-5.6-luna` / `medium` | workspace-write | small, unambiguous task with narrow DoD |
| Develop | Terra → Luna → Terra | mixed | important development without a complete specification |

`Develop` means: Plan → Prime only if strategy/system architecture changes → Build → independent Review. Build/Simple return `SPEC GAP: <missing requirement>` and stop if the specification is ambiguous.

## Task envelope

```text
TASK: <task-id-slug>
CODEX PROFILE: <prime|plan|review|build|simple>
TRACKS: <matching project tracks, or general>
TASK TYPE: <bugfix|feature|migration|research|review|refactor|docs>
BASE SHA: <git rev-parse HEAD>
ALLOWED PATHS: <files/dirs Codex may touch; NONE for read-only>
RELEVANT MEMORY: <compact excerpt; no secrets; none if unavailable>
DOD: <observable behavior and verification commands>
SPEC GAP POLICY: stop and report SPEC GAP instead of inventing requirements.
FORBIDDEN: do NOT git commit/push/rebase/reset; do NOT mass-upgrade dependencies; touch only ALLOWED PATHS.
REPORT BACK: profile/model/effort, files touched, tests run + result, known risks, base SHA, memory update candidate.
```

If the repository has a memory index, read the smallest relevant subset. Otherwise use `TRACKS: general` and `RELEVANT MEMORY: none`.

## Transports

1. **MCP sync** — small iterative work in a shared tree. Prime/Plan/Review use `read-only`; Build/Simple use `workspace-write` only after DoD is fixed.
2. **CLI background** — independent long work; every writer receives a separate worktree.
3. **Codex.app hand-off** — large or risky work requiring human control. Create `dev/codex-tasks/TASK-<id>.md` with the full envelope and DoD.

For CLI Build:

```bash
ROOT=$(git rev-parse --show-toplevel)
WT="$(dirname "$ROOT")/$(basename "$ROOT")-codex-<task-id>"
git worktree add "$WT" HEAD
scripts/dev/codex-exec.sh -C "$WT" -o "/tmp/codex-<task-id>.out" -s workspace-write -m gpt-5.6-luna -e high '<task envelope + task>'
```

Use Luna/medium for Simple. Readers use read-only and may work in the shared tree. Limit parallelism to one writer plus one or two readers.

## Review-gate

Codex never commits. The orchestrator must inspect the diff against `BASE SHA`, verify `ALLOWED PATHS` and DoD, run the stated tests/linters, resolve stale-base conflicts deliberately, scrub private data, and accept only green evidence. Commit remains an orchestrator/user action.

## Rules

- Do not use models older than GPT-5.6 for this skill's active routing.
- Do not use Prime for ordinary implementation; reserve Sol for strategy and high-value judgment.
- Do not pass secrets or unnecessary environment variables.
- Never use `--dangerously-bypass-approvals-and-sandbox`.
- Do not start a writer without DoD and allowed paths.
