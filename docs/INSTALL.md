# Install

## Apply to a project

```bash
git clone <this-repo-url> agent-workflow-kit
cd agent-workflow-kit
./scripts/apply-kit.sh /path/to/project

# Optional CFS/OpenClaw ops pack:
./scripts/apply-kit.sh --pack cfs /path/to/project
```

The script creates:

- `CLAUDE.md`
- `AGENTS.md`
- `.claude/hooks/*`
- `.claude/skills/codex-delegate/SKILL.md`
- `.scaffold/context.md`
- `.scaffold/rules.md`
- `.scaffold/constraints.md`
- `.scaffold/done-criteria.md`
- `.scaffold/skills/*`
- `scripts/dev/codex-exec.sh`
- `scripts/dev/setup-codex-mcp.sh`
- `dev/status.md`
- `dev/daily/.gitkeep`

With `--pack cfs`, it also creates:

- `.claude/skills/cfs-hub-ops/SKILL.md`
- `.claude/skills/cfs-docs-update/SKILL.md`
- `.scaffold/skills/cfs-hub-ops.md`
- `.scaffold/skills/cfs-docs-update.md`
- `.mcp.cfs.example.json`
- `docs/CFS_PACK.md`

and merges CFS skill hints into `.claude/skills/skill-rules.json` plus Scaffold catalog entries.

Existing files are not overwritten unless you pass `--force`.

## Optional Codex MCP transport

The delegate skill works through CLI background work without MCP. To enable the interactive Claude Code ↔ Codex transport, run inside the target repository:

```bash
scripts/dev/setup-codex-mcp.sh --scope user
scripts/dev/setup-codex-mcp.sh --check
```

The script registers the stdio server `codex mcp-server`. It does not write credentials and refuses to overwrite a different existing MCP named `codex`. Use `--scope project` only when the transport must be project-local.

## Customize after install

1. Replace `TODO:` placeholders in `CLAUDE.md`, `.scaffold/context.md` and `.scaffold/rules.md`.
2. Add project-specific denylist patterns to `.scrub-denylist`.
3. Remove unused skills from `.claude/skills/skill-rules.json`.
4. Run:

```bash
./scripts/scrub-check.sh
./scripts/smoke-test.sh
```

For CFS pack validation:

```bash
AGENT_WORKFLOW_SMOKE_PACKS=cfs ./scripts/smoke-test.sh
```

## Re-running the installer

Re-running `apply-kit.sh` with the same arguments is a no-op. Existing files are
left alone, and the CFS pack no longer re-merges its skill hints once its skills
are already present — so a skill you removed in step 3 above stays removed.

`scripts/smoke-test.sh` enforces this: it applies the kit, hand-edits `CLAUDE.md`,
removes a pack skill hint, applies again, and fails if anything in the target
changed. Without that test the guarantee was false — the pack merge used to put
removed hints back on every run.

To pick up kit changes deliberately, pass `--force` — it overwrites, including
your edits. Diff first.
