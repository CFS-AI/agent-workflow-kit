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

## One-command install

Install the kit into an existing Git project and choose models for the Fable
and Claude agents:

```bash
curl -fsSL https://raw.githubusercontent.com/CFS-AI/agent-workflow-kit/main/scripts/install.sh | bash -s -- /path/to/your/project
```

Choose `GPT-5.6 Sol`, provide a custom OpenCode `provider/model` ID for a GPT,
Gemini, or other provider, or keep either current agent unchanged. For
non-interactive installs, make changes explicit:

```bash
curl -fsSL https://raw.githubusercontent.com/CFS-AI/agent-workflow-kit/main/scripts/install.sh | bash -s -- --fable-model openai/gpt-5.6-sol --fable-variant high --claude-model google/gemini-2.5-pro --claude-variant high /path/to/your/project
```

Use `--fable-model keep` or `--claude-model keep` to leave either existing
configuration unchanged. The installer backs up an existing agent file before
replacing it. Restart OpenCode after installation.

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

## Optional CFS pack

The CFS pack is for OpenClaw/CFS-style operations and includes:

- `cfs-hub-ops` — read-only infra monitoring triage through cfs-hub MCP;
- `cfs-docs-update` — docs-first + docs-update workflow around CFS Docs/docs-intel;
- `.mcp.cfs.example.json` — placeholder MCP config for `cfs-hub`, `docs-intel-team-dev`, `docs-intel-legal`.

It deliberately excludes personal `/eod`, CEO private rollups, raw daily/status files, live secrets, raw client data and live infrastructure addresses.

## License

MIT — use, fork and adapt.
