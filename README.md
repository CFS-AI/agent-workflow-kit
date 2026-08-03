# Agent Workflow Kit

Shareable workflow template for running an engineering workspace with three cooperating surfaces:

- **Claude Code** — interactive orchestration, hooks, skill routing, daily/status memory.
- **Scaffold / prime** — structured clarification → diagnosis → plan → approval → build/review loop.
- **Codex Delegate** — routine implementation in a sandbox/worktree, accepted only through review-gate.
- **Autonomy ladder** — bounded turn, goal, time and proactive loops with explicit evidence and stop conditions.

The default install is domain-neutral. Optional packs add reusable domain workflows without secrets or private data.

## What you get

```text
templates/
  claude/              # CLAUDE.md, AGENTS.md, hooks, codex-delegate skill
  scaffold/            # context/rules/constraints/done-criteria + skill index cards
  demo-workspace/      # tiny project used by smoke-test
packs/
  cfs/                 # optional CFS/OpenClaw ops pack: cfs-hub + docs-intel workflows
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

# Apply core + CFS pack:
./scripts/apply-kit.sh --pack cfs /path/to/your/project
```

After applying, open the target project in Claude Code or Scaffold and read:

1. `CLAUDE.md`
2. `AGENTS.md`
3. `.scaffold/context.md`
4. `.scaffold/rules.md`

For MCP sync with Codex, install the transport explicitly after applying the kit:

```bash
scripts/dev/setup-codex-mcp.sh --scope user
```

This registers only `codex mcp-server`; it does not copy credentials or modify sandbox profiles.

Then customize placeholders marked `TODO:`.

## Core rules

1. **State lives in git.** Keep `dev/status.md` and `dev/daily/YYYY-MM-DD.md` current.
2. **No blind implementation.** Diagnose first, plan second, implement after approval.
3. **Delegate routine work, not ownership.** Codex can edit; the orchestrator reviews, tests and commits.
4. **One writer per worktree.** Parallel agents get isolated git worktrees.
5. **Publish only scrubbed artifacts.** Run `./scripts/scrub-check.sh` before pushing.

## Providers (subscription by default, paid API opt-in)

Review and planning calls go through `.claude/hooks/providers.js`. By default every
profile runs on the Codex CLI, where an extra call is covered by the subscription.
A paid HTTP provider (DeepSeek) can serve individual profiles, but it is opt-in and
guarded, because it changes two things at once: calls cost money, and the answer can
come back as prose instead of a verdict.

```bash
export AGENT_KIT_PROVIDER_REVIEW=deepseek         # move one profile, not all of them
export DEEPSEEK_API_KEY=...                       # never committed; read at call time
export AGENT_KIT_BUDGET_USD=5                     # required — no ceiling, no metered call
export AGENT_KIT_MODEL_PRICES='{"deepseek-chat":{"in":0.27,"out":1.1}}'
```

Rules the layer enforces:

- **A model with no declared price is unpriced, never free.** An unpriced paid model
  silently recorded at $0 is how a budget goes blind, so the call is refused instead.
- **No ceiling, no metered call.** `AGENT_KIT_BUDGET_USD` is required, and spend
  accrues across turns so the ceiling bounds the routine rather than one call.
- **A response without an `APPROVE`/`WARN`/`BLOCK` verdict is a failed call**, not a
  quiet approval, and the prose is never passed on dressed as a verdict.
- **Any of the above escalates to the subscription provider**, reporting what it
  escalated from and why. Escalation is never silent.

Prices in the example above are placeholders — declare the ones you have actually
verified with the vendor. Verify the layer with `node --test tests/*.test.js`: the
transport is injected, so the suite needs no API key and makes no network calls.

## Optional CFS pack

The CFS pack is for OpenClaw/CFS-style operations and includes:

- `cfs-hub-ops` — read-only infra monitoring triage through cfs-hub MCP;
- `cfs-docs-update` — docs-first + docs-update workflow around CFS Docs/docs-intel;
- `.mcp.cfs.example.json` — placeholder MCP config for `cfs-hub`, `docs-intel-team-dev`, `docs-intel-legal`.

It deliberately excludes personal `/eod`, CEO private rollups, raw daily/status files, live secrets, raw client data and live infrastructure addresses.

## License

MIT — use, fork and adapt.
