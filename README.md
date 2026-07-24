# Agent Workflow Kit

A portable, Git-friendly operating system for AI-assisted engineering work.

Agent Workflow Kit gives a repository a consistent way to orchestrate Claude Code, Scaffold/Prime, and Codex: establish context, diagnose before changing code, delegate bounded work, verify it, and retain durable project state.

## Included

```text
templates/
  claude/              Claude Code instructions, hooks, and delegation skill
  scaffold/            Context, rules, constraints, completion criteria, skills
  demo-workspace/      Minimal project used by the smoke test
packs/
  cfs/                 Optional CFS/OpenClaw operations workflow pack
scripts/
  apply-kit.sh         Install templates in an existing repository
  install.sh           Download, install, and optionally configure OpenCode agents
  codex-exec.sh        Hardened Codex CLI wrapper
  setup-codex-mcp.sh   Optional Claude Code ↔ Codex MCP transport setup
  smoke-test.sh        Validate a clean installation
  scrub-check.sh       Check publishable content against the denylist
docs/                  Installation, workflow, review, and scrubbing guidance
```

## Quick start

```bash
git clone https://github.com/Baggrisha/agent-workflow-kit.git
cd agent-workflow-kit
./scripts/smoke-test.sh

# Install the core kit in an existing Git repository.
./scripts/apply-kit.sh /path/to/project

# Include the optional CFS/OpenClaw operations pack.
./scripts/apply-kit.sh --pack cfs /path/to/project
```

Existing files are preserved by default. Pass `--force` only when you intend to replace them.

## One-command installer

```bash
curl -fsSL https://raw.githubusercontent.com/Baggrisha/agent-workflow-kit/main/scripts/install.sh | bash -s -- /path/to/project
```

The installer can optionally configure OpenCode's `fable` and `claude` agents interactively. For non-interactive use, specify the models explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/Baggrisha/agent-workflow-kit/main/scripts/install.sh | \
  bash -s -- \
    --fable-model openai/gpt-5.6-sol --fable-variant high \
    --claude-model google/gemini-2.5-pro --claude-variant high \
    /path/to/project
```

Use `--fable-model keep` or `--claude-model keep` to preserve an existing agent configuration. See [docs/INSTALL.md](docs/INSTALL.md) for options, update guidance, and optional Codex MCP transport.

## Operating model

1. **Read context first.** Consult `dev/status.md` and record session work in `dev/daily/`.
2. **Diagnose before implementation.** Establish evidence, make a concise plan, and get approval for edits or deployments.
3. **Delegate bounded work, not ownership.** Codex can research or implement inside a defined scope; the orchestrator reviews and accepts it.
4. **Verify with an oracle.** Use a test, lint, health check, UI observation, or state diff—not an unsupported completion claim.
5. **Keep the repository clean.** Commit accepted work and keep durable state in Git.
6. **Publish safely.** Run `./scripts/scrub-check.sh` before sharing changes.

Read the full [workflow](docs/WORKFLOW.md) and [review gate](docs/REVIEW_GATE.md) before using delegation or autonomous loops.

## Optional CFS pack

The CFS pack adds reusable, shareable workflows for:

- read-only infrastructure triage through `cfs-hub`;
- docs-first research and documentation updates through `docs-intel`.

It ships only templates and placeholder MCP configuration—never credentials, private operations data, live infrastructure addresses, or personal work logs. Details: [packs/cfs/README.md](packs/cfs/README.md).

## Validate before publishing

```bash
./scripts/smoke-test.sh
./scripts/scrub-check.sh

# Also validate the optional pack.
AGENT_WORKFLOW_SMOKE_PACKS=cfs ./scripts/smoke-test.sh
```

The scrubber is a safety net, not a substitute for review. Read [docs/SCRUBBING.md](docs/SCRUBBING.md) and add project-specific terms to `.scrub-denylist`.

## License

[MIT](LICENSE)
