# Agent Workflow Kit

Shareable workflow template for running an engineering workspace with three cooperating surfaces:

- **Claude Code** — interactive orchestration, hooks, skill routing, daily/status memory.
- **Scaffold / prime** — structured clarification → diagnosis → plan → approval → build/review loop.
- **Codex Delegate** — routine implementation in a sandbox/worktree, accepted only through review-gate.

The kit is intentionally domain-neutral: no client data, no company-specific runbooks, no credentials, no live infrastructure assumptions.

## What you get

```text
templates/
  claude/              # CLAUDE.md, AGENTS.md, hooks, codex-delegate skill
  scaffold/            # context/rules/constraints/done-criteria + skill index cards
  demo-workspace/      # tiny project used by smoke-test
scripts/
  apply-kit.sh         # copy templates into a target repository
  codex-exec.sh        # hardened Codex CLI wrapper
  smoke-test.sh        # create demo workspace and validate structure
  scrub-check.sh       # denylist check before publishing/sharing
docs/
  WORKFLOW.md          # operating model
  INSTALL.md           # install/update instructions
  SCRUBBING.md         # what must never be shared
  REVIEW_GATE.md       # accepting delegated work safely
```

## Quick start

```bash
git clone <this-repo-url> agent-workflow-kit
cd agent-workflow-kit
./scripts/smoke-test.sh

# Apply to an existing project:
./scripts/apply-kit.sh /path/to/your/project
```

After applying, open the target project in Claude Code or Scaffold and read:

1. `CLAUDE.md`
2. `AGENTS.md`
3. `.scaffold/context.md`
4. `.scaffold/rules.md`

Then customize placeholders marked `TODO:`.

## Core rules

1. **State lives in git.** Keep `dev/status.md` and `dev/daily/YYYY-MM-DD.md` current.
2. **No blind implementation.** Diagnose first, plan second, implement after approval.
3. **Delegate routine work, not ownership.** Codex can edit; the orchestrator reviews, tests and commits.
4. **One writer per worktree.** Parallel agents get isolated git worktrees.
5. **Publish only scrubbed artifacts.** Run `./scripts/scrub-check.sh` before pushing.

## License

MIT — use, fork and adapt.
